import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mcpServer } from "../src/mcp.ts";
import { World, call, say } from "./world.ts";
import type { AgentInput } from "../src/config.ts";

let worlds: World[] = [];
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  for (const w of worlds) w.dispose();
  worlds = [];
});

async function world(agents?: Record<string, AgentInput>): Promise<World> {
  const w = new World({ local: true, ...(agents ? { agents } : {}) });
  worlds.push(w);
  return w.start();
}

/** A client talking to `aoa mcp` over the SDK's in-memory pair, on the world's own agent. */
async function connect(w: World): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([mcpServer(w.agent).connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return client;
}

type Reply = { error: boolean; text: string };

async function use(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const r = await client.callTool({ name, arguments: args });
  const [first] = r.content as { type: string; text: string }[];
  return { error: r.isError === true, text: first!.text };
}

/** The tool's JSON result; fails the test with the message when the call was an error. */
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await use(client, name, args);
  expect(r).toMatchObject({ error: false });
  return JSON.parse(r.text);
}

/** The CLI's error message for the same request, to compare with the tool's. */
async function cliError(w: World, ...argv: string[]): Promise<string> {
  const r = await w.cli(...argv);
  expect(r.code).toBe(1);
  return r.err.trim();
}

describe("aoa mcp", () => {
  test("lists the five tools; send opens a task that status then shows", async () => {
    const w = await world();
    const client = await connect(w);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["answer", "close", "messages", "send", "status"]);

    w.script([say("On it.")]);
    const { thread } = await ok(client, "send", { text: "Add a greeting file." });
    expect(thread).toMatch(/^local:/);
    await w.drain();

    const report = await ok(client, "status");
    expect(report.sessions).toEqual([expect.objectContaining({ thread, state: "open", outcome: "in progress" })]);
    expect(JSON.stringify(w.modelRequests.at(-1))).toContain("Add a greeting file.");
  });

  test("send with agent and branch follows the CLI's rules and errors, and an error appends nothing", async () => {
    const w = await world({ reviewer: { role: "review" } });
    const client = await connect(w);
    const before = { default: w.events().length, reviewer: w.events("reviewer").length };

    const refusals: [Record<string, unknown>, string[]][] = [
      [{ text: "Look.", agent: "nobody" }, ["send", "--agent", "nobody", "Look."]],
      [{ text: "Look.", branch: "main" }, ["send", "--branch", "main", "Look."]],
      [{ text: "Look.", agent: "reviewer", branch: "no-such-branch" }, ["send", "--agent", "reviewer", "--branch", "no-such-branch", "Look."]],
      [{ text: "  " }, ["send", "  "]],
    ];
    for (const [args, argv] of refusals) {
      const r = await use(client, "send", args);
      expect(r).toEqual({ error: true, text: await cliError(w, ...argv) });
    }
    const both = await use(client, "send", { text: "Look.", to: "local:", agent: "reviewer" });
    expect(both.error).toBe(true);
    expect({ default: w.events().length, reviewer: w.events("reviewer").length }).toEqual(before);

    const { thread } = await ok(client, "send", { text: "Review main.", agent: "reviewer", branch: "main" });
    expect(w.events("reviewer").at(-1)).toMatchObject({ thread, payload: { text: "Review main.", branch: "main" } });
    expect(w.events()).toHaveLength(before.default);
  });

  test("close records the result in local mode, with the CLI's errors", async () => {
    const w = await world();
    const client = await connect(w);
    w.script([say("On it.")]);
    const { thread } = await ok(client, "send", { text: "Add a greeting file." });
    await w.drain();

    const bad = await use(client, "close", { thread: "local:zz", outcome: "merged" });
    expect(bad).toEqual({ error: true, text: await cliError(w, "close", "local:zz", "merged") });

    await ok(client, "close", { thread, outcome: "merged" });
    expect((await ok(client, "status")).sessions[0]).toMatchObject({ outcome: "merged" });
  });
});

describe("aoa mcp send to a waiting task", () => {
  test("on a task waiting for an approval, send is refused, names the call and appends nothing", async () => {
    const w = await world();
    const client = await connect(w);
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script([call("bash", { command: "echo deployed >> deploy.log" }), say("Deployed.")]);
    const { thread } = await ok(client, "send", { text: "Deploy it." });
    await w.drain();
    const session = w.sessions()[0]!;
    expect(session).toMatchObject({ status: "paused" });
    const events = w.events().length;

    for (const text of ["/approve", "Not today."]) {
      const r = await use(client, "send", { to: thread, text });
      expect(r.error).toBe(true);
      expect(r.text).toContain(session.pending!);
    }
    expect(w.events()).toHaveLength(events);
    expect(w.sessions()[0]).toMatchObject({ status: "paused", pending: session.pending });
    expect((await ok(client, "status")).pending.map((p: { callId: string }) => p.callId)).toEqual([session.pending]);
  });

  test("on a task waiting for an answer to its question, the text is the answer", async () => {
    const w = await world();
    const client = await connect(w);
    w.script([call("ask_user", { question: "Which file name?" }), say("Thanks.")]);
    const { thread } = await ok(client, "send", { text: "Add a greeting file." });
    await w.drain();
    const session = w.sessions()[0]!;
    expect(session).toMatchObject({ status: "paused" });

    await ok(client, "send", { to: thread.slice(0, 10), text: "hello.txt" });
    expect(w.events().at(-1)).toMatchObject({
      source: "approval_answer",
      resume: session.id,
      payload: { callId: session.pending, verdict: "approve", text: "hello.txt" },
    });
    await w.drain();
    expect(w.sessions()[0]).toMatchObject({ status: "open", pending: null });
    expect(JSON.stringify(w.modelRequests.at(-1))).toContain("hello.txt");
  });
});

describe("aoa mcp messages", () => {
  test("with wait, returns as soon as a message is queued", async () => {
    const w = await world();
    const client = await connect(w);
    w.script([call("notify", { body: "Finished while you waited." }), say("Done.")]);
    await ok(client, "send", { text: "Do it." });
    const started = w.clock.now();

    let done = false;
    const waiting = ok(client, "messages", { wait: 60 }).then((l) => {
      done = true;
      return l;
    });
    // The call is asleep on the clock: nothing has been queued yet.
    await Promise.race([waiting, w.clock.timerDueBy(started + 1000)]);
    expect(done).toBe(false);

    await w.drain();
    // The run queued the message; the call's next look finds it.
    await Promise.race([waiting, w.clock.timerDueBy(w.clock.now() + 1000)]);
    w.advance(1000);
    const listing = await waiting;
    expect(listing.messages.map((m: { body: string }) => m.body)).toEqual(["Finished while you waited."]);
    expect(listing.cursor).toBe(listing.messages[0].id);
    expect(w.clock.now() - started).toBeLessThan(60_000);
  });

  test("with wait, returns nothing and the same cursor when the time is up", async () => {
    const w = await world();
    const client = await connect(w);
    w.script([call("notify", { body: "First." }), say("Done.")]);
    await ok(client, "send", { text: "Do it." });
    await w.drain();
    const { cursor } = await ok(client, "messages");
    expect(cursor).not.toBeNull();

    let done = false;
    const waiting = ok(client, "messages", { since: cursor, wait: 5 }).then((l) => {
      done = true;
      return l;
    });
    const started = w.clock.now();
    while (!done) {
      await Promise.race([waiting, w.clock.timerDueBy(w.clock.now() + 1000)]);
      if (!done) w.advance(1000);
    }
    expect(w.clock.now() - started).toBe(5000);
    expect(await waiting).toEqual({ messages: [], cursor });
  });

  test("a wait longer than two minutes is refused", async () => {
    const w = await world();
    const client = await connect(w);
    expect((await use(client, "messages", { wait: 121 })).error).toBe(true);
  });
});
