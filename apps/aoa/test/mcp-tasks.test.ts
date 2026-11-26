import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { CancelTaskResultV2Schema, CreateTaskResultV2Schema, GetTaskResultV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { serveMcp } from "../src/mcp.ts";
import { World, call, say } from "./world.ts";

const TASKS = "io.modelcontextprotocol/tasks";

let worlds: World[] = [];
let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
  for (const w of worlds) w.dispose();
  worlds = [];
});

type Caps = { tasks?: boolean; elicitation?: boolean };
type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };
type Listing = { messages: { id: string; kind: string; body: string; callId: string | null; pending?: boolean }[]; cursor: string | null };

/**
 * A 2026-07-28 client on raw JSON-RPC: the SDK client rejects `resultType: "task"`, and these tests check the wire.
 * Every request carries the per-request envelope with the capabilities `caps` declares.
 */
async function modern(w: World, caps: Caps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const handle = serveMcp(w.agent, a);
  const waiting = new Map<number, (m: Rpc) => void>();
  b.onmessage = (m) => {
    const msg = m as Rpc & { id?: number };
    if (typeof msg.id === "number") waiting.get(msg.id)?.(msg);
  };
  await b.start();
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {
      ...(caps.tasks ? { extensions: { [TASKS]: {} } } : {}),
      ...(caps.elicitation ? { elicitation: { form: {} } } : {}),
    },
  };
  let id = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Rpc>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      void b.send({ jsonrpc: "2.0", id: n, method, params: { ...params, _meta: meta } });
    });
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result!;
  /** The JSON a tool result, or a completed task's result, carries in its text content. */
  const text = <T>(r: Record<string, unknown>): T => JSON.parse((r.content as { text: string }[])[0]!.text) as T;
  const get = async (taskId: string) => GetTaskResultV2Schema.parse((await rpc("tasks/get", { taskId })).result);
  closers.push(() => handle.close());
  return { rpc, tool, text, get };
}

async function world(caps: Caps) {
  const w = new World({ local: true });
  worlds.push(w);
  await w.start();
  return { w, ...(await modern(w, caps)) };
}

test("server/discover advertises the tasks extension", async () => {
  const s = await world({});
  const r = await s.rpc("server/discover");
  expect((r.result!.capabilities as { extensions: Record<string, unknown> }).extensions[TASKS]).toEqual({});
});

describe("messages with wait, for a client that declares Tasks", () => {
  test("returns a task that completes with what messages returns once something new is queued", async () => {
    const s = await world({ tasks: true });
    s.w.script([call("notify", { body: "Finished." }), say("Done.")]);
    await s.tool("send", { text: "Do it." });

    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    expect(task).toMatchObject({ status: "working", ttlMs: null });
    expect(await s.get(task.taskId)).toMatchObject({ status: "working" });

    await s.w.drain();
    const done = await s.get(task.taskId);
    expect(done.status).toBe("completed");
    const listing = s.text<Listing>((done as unknown as { result: Record<string, unknown> }).result);
    expect(listing.messages.map((m) => m.body)).toEqual(["Finished."]);
    expect(listing).toEqual(s.text<Listing>(await s.tool("messages")));
    // A terminal state stays put.
    expect(await s.get(task.taskId)).toEqual(done);
  });

  test("returns at once when there is already something new, and without wait, as before", async () => {
    const s = await world({ tasks: true });
    s.w.script([call("notify", { body: "First." }), say("Done.")]);
    await s.tool("send", { text: "Do it." });
    await s.w.drain();

    const now = await s.tool("messages", { wait: 60 });
    expect(now.resultType).not.toBe("task");
    const { cursor } = s.text<Listing>(now);
    expect(s.text<Listing>(await s.tool("messages", { since: cursor }))).toEqual({ messages: [], cursor });
  });

  test("waits from its cursor: the task holds it, so a poll after a reconnect still finds the wait", async () => {
    const s = await world({ tasks: true });
    s.w.script([call("notify", { body: "First." }), say("Done."), call("notify", { body: "Second." }), say("Done.")]);
    const { thread } = s.text<{ thread: string }>(await s.tool("send", { text: "Do it." }));
    await s.w.drain();
    const { cursor } = s.text<Listing>(await s.tool("messages"));

    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { since: cursor, wait: 60 }));
    await s.tool("send", { to: thread, text: "Again." });
    await s.w.drain();

    const other = await modern(s.w, { tasks: true });
    const done = await other.get(task.taskId);
    expect(done.status).toBe("completed");
    expect(s.text<Listing>((done as unknown as { result: Record<string, unknown> }).result).messages.map((m) => m.body)).toEqual(["Second."]);
  });

  test("cancelling stops the wait only: it stays cancelled when a message arrives", async () => {
    const s = await world({ tasks: true });
    s.w.script([call("notify", { body: "Finished." }), say("Done.")]);
    await s.tool("send", { text: "Do it." });
    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));

    CancelTaskResultV2Schema.parse((await s.rpc("tasks/cancel", { taskId: task.taskId })).result);
    await s.w.drain();
    expect(await s.get(task.taskId)).toMatchObject({ status: "cancelled" });
    expect(s.text<Listing>(await s.tool("messages")).messages.map((m) => m.body)).toEqual(["Finished."]);
  });

  test("a task id that is not a wait is refused", async () => {
    const s = await world({ tasks: true });
    for (const taskId of ["nope", "wait:not-a-message:1:00000000"]) {
      expect((await s.rpc("tasks/get", { taskId })).error).toBeDefined();
    }
  });

  test("a client without Tasks still gets a plain wait", async () => {
    const s = await world({});
    s.w.script([call("notify", { body: "First." }), say("Done.")]);
    await s.tool("send", { text: "Do it." });
    await s.w.drain();
    expect(s.text<Listing>(await s.tool("messages", { wait: 60 })).messages.map((m) => m.body)).toEqual(["First."]);
  });
});

describe("calls waiting on the user go to them as forms, for a client that declares form elicitation", () => {
  type Form = { method: string; params: { message: string; requestedSchema: { properties: Record<string, { enum?: string[] }>; required: string[] } } };

  /** A world whose agent asks to deploy, which the classifier leaves to the user, and then says it did. */
  async function deploying(caps: Caps = { tasks: true, elicitation: true }) {
    const s = await world(caps);
    s.w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    s.w.script([call("bash", { command: "echo deployed >> deploy.log" }), call("notify", { body: "Deployed." }), say("Done.")]);
    await s.tool("send", { text: "Deploy it." });
    await s.w.drain();
    const callId = s.w.sessions()[0]!.pending!;
    expect(callId).toBeTruthy();
    return { ...s, callId };
  }

  async function inputs(s: Awaited<ReturnType<typeof world>>, taskId: string): Promise<Record<string, Form>> {
    const got = await s.get(taskId);
    expect(got.status).toBe("input_required");
    return (got as unknown as { inputRequests: Record<string, Form> }).inputRequests;
  }

  test("an approval asks for a decision on the whole call; approving it lets the agent go on, and the wait ends with what it said", async () => {
    const s = await deploying();
    // The request is already queued when the wait starts: the form still goes out.
    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    const form = (await inputs(s, task.taskId))[s.callId]!;
    expect(form.method).toBe("elicitation/create");
    expect(form.params.message).toContain("echo deployed >> deploy.log");
    expect(form.params.message).not.toContain("/approve");
    expect(form.params.requestedSchema.properties.decision!.enum).toEqual(["approve", "deny"]);
    expect(form.params.requestedSchema.required).toEqual(["decision"]);

    await s.rpc("tasks/update", { taskId: task.taskId, inputResponses: { [s.callId]: { action: "accept", content: { decision: "approve" } } } });
    expect(s.w.events().at(-1)).toMatchObject({ source: "approval_answer", payload: { callId: s.callId, verdict: "approve", via: "elicitation" } });
    expect(await s.get(task.taskId)).toMatchObject({ status: "working" });

    await s.w.drain();
    const done = await s.get(task.taskId);
    expect(done.status).toBe("completed");
    const listing = s.text<Listing>((done as unknown as { result: Record<string, unknown> }).result);
    expect(listing.messages.at(-1)!.body).toBe("Deployed.");
    expect(listing).toEqual(s.text<Listing>(await s.tool("messages")));
  });

  test("denying with a reason passes the reason on", async () => {
    const s = await deploying();
    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    await inputs(s, task.taskId);
    await s.rpc("tasks/update", {
      taskId: task.taskId,
      inputResponses: { [s.callId]: { action: "accept", content: { decision: "deny", reason: "Not on a Friday." } } },
    });
    expect(s.w.events().at(-1)).toMatchObject({ payload: { callId: s.callId, verdict: "deny", text: "Not on a Friday.", via: "elicitation" } });
  });

  test("a question asks for its answer as text", async () => {
    const s = await world({ tasks: true, elicitation: true });
    s.w.script([call("ask_user", { question: "Which file name?" }), call("notify", { body: "Thanks." }), say("Done.")]);
    await s.tool("send", { text: "Add a greeting file." });
    await s.w.drain();
    const callId = s.w.sessions()[0]!.pending!;

    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    const form = (await inputs(s, task.taskId))[callId]!;
    expect(form.params.message).toContain("Which file name?");
    expect(form.params.requestedSchema.required).toEqual(["answer"]);

    await s.rpc("tasks/update", { taskId: task.taskId, inputResponses: { [callId]: { action: "accept", content: { answer: "hello.txt" } } } });
    expect(s.w.events().at(-1)).toMatchObject({ payload: { callId, verdict: "approve", text: "hello.txt", via: "elicitation" } });
  });

  test("declining, or accepting without a decision, leaves the call waiting and ends the wait with it", async () => {
    for (const response of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: {} }, { action: "accept", content: { decision: "maybe" } }]) {
      const s = await deploying();
      const events = s.w.events().length;
      const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
      await inputs(s, task.taskId);
      await s.rpc("tasks/update", { taskId: task.taskId, inputResponses: { [s.callId]: response } });
      expect(s.w.events()).toHaveLength(events);

      const done = await s.get(task.taskId);
      expect(done.status).toBe("completed");
      const listing = s.text<Listing>((done as unknown as { result: Record<string, unknown> }).result);
      expect(listing.messages.map((m) => [m.callId, m.pending])).toEqual([[s.callId, true]]);
      // A declined call is not asked again on this connection: a new wait returns it at once.
      expect((await s.tool("messages", { wait: 60 })).resultType).not.toBe("task");
    }
  });

  test("an update takes only the ids it asked about, by their whole id", async () => {
    const s = await deploying();
    const events = s.w.events().length;
    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    await inputs(s, task.taskId);
    const r = await s.rpc("tasks/update", {
      taskId: task.taskId,
      inputResponses: { [s.callId.slice(0, 8)]: { action: "accept", content: { decision: "approve" } }, other: { action: "accept" } },
    });
    expect(r.error).toBeUndefined();
    expect(s.w.events()).toHaveLength(events);
    expect(await s.get(task.taskId)).toMatchObject({ status: "input_required" });
  });

  test("a call answered elsewhere since the poll is not answered again", async () => {
    const s = await deploying();
    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    await inputs(s, task.taskId);
    expect((await s.w.cli("answer", s.callId, "deny", "from the CLI")).code).toBe(0);
    const r = await s.rpc("tasks/update", { taskId: task.taskId, inputResponses: { [s.callId]: { action: "accept", content: { decision: "approve" } } } });
    expect(r.error).toBeUndefined();
    const answers = s.w.events().filter((e) => e.source === "approval_answer");
    expect(answers.map((e) => (e.payload as { verdict: string; text?: string }).text)).toEqual(["from the CLI"]);
  });

  test("cancelling the wait leaves the call waiting and does not ask it again", async () => {
    const s = await deploying();
    const task = CreateTaskResultV2Schema.parse(await s.tool("messages", { wait: 60 }));
    await inputs(s, task.taskId);
    await s.rpc("tasks/cancel", { taskId: task.taskId });
    expect(await s.get(task.taskId)).toMatchObject({ status: "cancelled" });
    expect(s.w.sessions()[0]).toMatchObject({ status: "paused", pending: s.callId });
    expect((await s.tool("messages", { wait: 60 })).resultType).not.toBe("task");
  });

  test("without form elicitation, a waiting approval ends the wait as it does today", async () => {
    const s = await deploying({ tasks: true });
    const r = await s.tool("messages", { wait: 60 });
    expect(r.resultType).not.toBe("task");
    expect(s.text<Listing>(r).messages.map((m) => [m.callId, m.pending])).toEqual([[s.callId, true]]);
  });
});
