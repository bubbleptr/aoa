import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { sqliteStore, systemClock } from "@aoa-dev/sdk";
import { validateConfig } from "../src/config.ts";
import type { Edge, Snapshot } from "../src/observe.ts";
import { type Web, startWeb } from "../src/web.ts";
import { type Agent, assemble } from "../src/wiring.ts";
import { World, call, say } from "./world.ts";

type Update = { snapshot: Snapshot; flows: Partial<Record<Edge, number>> };

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function world(): Promise<World> {
  const w = new World({ local: true });
  cleanup.push(() => w.dispose());
  return w.start();
}

function web(agent: Agent, watch?: (onChange: () => void) => () => void): Web {
  const server = startWeb(agent, { port: 0, ...(watch ? { watch } : {}) });
  cleanup.push(() => server.stop());
  return server;
}

/** An SSE client: `next()` resolves with the next update the server pushes. */
async function subscribe(server: Web) {
  const res = await fetch(`http://127.0.0.1:${server.port}/events`);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  cleanup.push(() => reader.cancel());
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<Update> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data !== "") return JSON.parse(data);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("the stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

/** A raw HTTP request, so the Host header is exactly what a browser on another site would send. */
function rawRequest(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`));
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

const statusLine = (response: string) => response.split("\r\n")[0];

test("pushes a snapshot on connect, then only changes, each carrying what flowed", async () => {
  const w = await world();
  let trigger = () => {};
  const server = web(w.agent, (onChange) => {
    trigger = onChange;
    return () => {};
  });
  const client = await subscribe(server);

  const first = await client.next();
  expect(first.flows).toEqual({});
  expect(first.snapshot.edges.in.total).toBe(0);

  await w.cli("send", "First task.");
  trigger();
  w.advance(50);
  const update = await client.next();
  expect(update.flows).toEqual({ in: 1 });
  expect(update.snapshot.events.counts.pending).toBe(1);

  // A trigger with nothing new pushes nothing: the next update is the next real change.
  trigger();
  w.advance(50);
  await w.cli("send", "Second task.");
  trigger();
  w.advance(50);
  const second = await client.next();
  expect(second.flows).toEqual({ in: 1 });
  expect(second.snapshot.edges.in.total).toBe(2);

  const snapshot = (await (await fetch(`http://127.0.0.1:${server.port}/snapshot`)).json()) as Snapshot;
  expect(snapshot.edges.in.total).toBe(2);
});

test("the page flips to serve offline when the heartbeat goes stale, without a write", async () => {
  const w = await world();
  let trigger = () => {};
  const server = web(w.agent, (onChange) => {
    trigger = onChange;
    return () => {};
  });
  const client = await subscribe(server);
  expect((await client.next()).snapshot.serve.state).toBe("never");

  const other = sqliteStore(w.agent.paths.db);
  const lock = other.lock()!;
  lock.beat(w.clock.now());
  lock.release();
  other.close();
  trigger();
  w.advance(50);
  expect((await client.next()).snapshot.serve.state).toBe("running");

  w.advance(15_000);
  expect((await client.next()).snapshot.serve.state).toBe("offline");
});

test("only GET from a localhost Host is served", async () => {
  const w = await world();
  const server = web(w.agent, () => () => {});
  const { port } = server;

  expect((await fetch(`http://127.0.0.1:${port}/snapshot`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  expect(statusLine(await rawRequest(port, ["GET /snapshot HTTP/1.1", `Host: localhost:${port}`]))).toContain("200");
  expect(statusLine(await rawRequest(port, ["GET /snapshot HTTP/1.1", `Host: attacker.example:${port}`]))).toContain("403");
  expect(statusLine(await rawRequest(port, ["GET /events HTTP/1.1", "Host: 127.0.0.1"]))).toContain("403");
});

test("a run's memory write reaches a client with the file's new text", async () => {
  const w = await world();
  const agent = assemble(validateConfig(w.config), { ...w.seams, clock: systemClock });
  cleanup.push(() => agent.close());
  const client = await subscribe(web(agent));
  await client.next();

  const write = (content: string) => [call("memory_write", { path: "notes/ci.md", content }), say("Noted.")];
  w.script(write("CI is red."));
  const thread = (await w.cli("send", "Note the CI state.")).out.trim();
  await w.drain();
  w.script(write("CI is green."));
  await w.cli("send", "--to", thread, "It passed now.");
  await w.drain();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const pushed = async () => {
    for (;;) {
      const update = await client.next();
      if (update.snapshot.memory.files.find((f) => f.path === "notes/ci.md")?.text === "CI is green.") return;
    }
  };
  try {
    await Promise.race([
      pushed(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the new text was not pushed within 3 s")), 3_000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("with the real file watch, another connection's write reaches a client", async () => {
  const w = await world();
  // Its own connection on the same store, on real time so the watch's debounce runs.
  const agent = assemble(validateConfig(w.config), { ...w.seams, clock: systemClock });
  cleanup.push(() => agent.close());
  const client = await subscribe(web(agent));
  expect((await client.next()).flows).toEqual({});

  await w.cli("send", "Watched task.");
  const update = await Promise.race([
    client.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no update within 3 s")), 3_000)),
  ]);
  expect(update.flows).toEqual({ in: 1 });
});

describe("answering from the page", () => {
  /** A world whose default task waits on a deferred `echo deployed` call, with the page serving it. */
  async function waiting(steps = [call("bash", { command: "echo deployed >> deploy.log" }), say("Deployed.")]) {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script(steps);
    await w.cli("send", "Deploy it.");
    await w.drain();
    const callId = w.sessions()[0]!.pending!;
    const server = web(w.agent, () => () => {});
    const origin = `http://127.0.0.1:${server.port}`;
    const post = (body: unknown, headers: Record<string, string> = { origin, "content-type": "application/json" }) =>
      fetch(`${origin}/answer`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { w, callId, server, origin, post };
  }

  const answers = (w: World) => w.events().filter((e) => e.source === "approval_answer");

  test("approve and deny write the same answer the CLI does, marked as from the page", async () => {
    const { w, callId, post } = await waiting();
    const res = await post({ callId, verdict: "deny", text: "Not today." });
    expect(res.status).toBe(200);
    expect(answers(w)).toMatchObject([{ status: "pending", payload: { callId, verdict: "deny", text: "Not today.", via: "web" } }]);
    await w.drain();
    expect(w.sessions()[0]).toMatchObject({ status: "open", pending: null });
  });

  test("a second answer to the same call is refused, not reported as accepted", async () => {
    const { w, callId, post } = await waiting();
    expect((await post({ callId, verdict: "approve" })).status).toBe(200);
    const again = await post({ callId, verdict: "deny" });
    expect(again.status).toBe(409);
    expect(answers(w).filter((e) => e.status === "pending")).toHaveLength(1);
  });

  test("a question takes the text as its answer", async () => {
    const { w, callId, post } = await waiting([call("ask_user", { question: "Which file name?" }), say("Thanks.")]);
    expect((await post({ callId, verdict: "approve", text: "hello.txt" })).status).toBe(200);
    expect(answers(w)).toMatchObject([{ payload: { callId, verdict: "approve", text: "hello.txt", via: "web" } }]);
  });

  test("anything but a JSON post from the page itself, naming a waiting call in full, is refused and appends nothing", async () => {
    const { w, callId, server, origin, post } = await waiting();
    const json = { "content-type": "application/json" };
    const refused = [
      await post({ callId, verdict: "approve" }, json),
      await post({ callId, verdict: "approve" }, { ...json, origin: `http://127.0.0.1:${server.port + 1}` }),
      await post({ callId, verdict: "approve" }, { ...json, origin: "https://attacker.example" }),
      await post(JSON.stringify({ callId, verdict: "approve" }), { origin, "content-type": "text/plain" }),
      await post({ callId: callId.slice(0, 8), verdict: "approve" }),
      await post({ callId: "", verdict: "approve" }),
      await post({ callId: "nope", verdict: "approve" }),
      await post({ callId, verdict: "maybe" }),
      await post("{not json"),
    ];
    for (const res of refused) expect(res.status).toBeGreaterThanOrEqual(400);
    expect(answers(w)).toHaveLength(0);

    const preflight = await fetch(`${origin}/answer`, { method: "OPTIONS", headers: { origin: "https://attacker.example" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${origin}/snapshot`, { method: "POST" })).status).toBe(405);
    expect(statusLine(await rawRequest(server.port, ["POST /answer HTTP/1.1", `Host: attacker.example:${server.port}`, `Origin: ${origin}`]))).toContain("403");
  });

  test("the page cannot be framed, and a waiting call shows in full with whether it is already answered", async () => {
    const long = `echo deployed ${"x".repeat(300)} >> deploy.log`;
    const { w, callId, origin, post } = await waiting([call("bash", { command: long }), say("Deployed.")]);
    expect((await fetch(`${origin}/`)).headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const before = ((await (await fetch(`${origin}/snapshot`)).json()) as Snapshot).permissions.waiting[0]!;
    expect(before).toMatchObject({ callId, kind: "approval", answered: null });
    expect(before.full).toContain(long);

    await post({ callId, verdict: "approve" });
    const after = ((await (await fetch(`${origin}/snapshot`)).json()) as Snapshot).permissions.waiting[0]!;
    expect(after).toMatchObject({ callId, answered: "approve" });
    void w;
  });
});

describe("notifications while the page is open", () => {
  /** Resolves once `ok()` holds; the server sees a connect or a disconnect a few event-loop turns later. */
  async function until(ok: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("a page with notifications on takes over the approval notification; closing it hands it back with the page's address", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    const server = web(w.agent, () => () => {});
    const url = `http://127.0.0.1:${server.port}`;
    expect(w.agent.page.state()).toEqual({ url, notifying: false });

    // A closed tab drops its connection; aborting the request is the same to the server.
    const tab = new AbortController();
    const watching = await fetch(`${url}/events?notify=1`, { signal: tab.signal, headers: { "sec-fetch-site": "same-origin" } });
    void watching.body!.getReader().read().catch(() => {});
    await until(() => w.agent.page.state()?.notifying === true);

    w.script([call("bash", { command: "echo deployed >> deploy.log" }), say("Deployed.")]);
    await w.cli("send", "Deploy it.");
    await w.drain();
    await w.dispatch();
    expect(w.agent.store.tx((t) => t.listOutbox(w.agent.inboxId))).toMatchObject([{ kind: "approval_request", status: "sent" }]);
    expect(w.notes.filter((n) => n.title.includes("needs your answer"))).toHaveLength(0);

    tab.abort();
    await until(() => w.agent.page.state()?.notifying === false);
    await w.cli("answer", w.sessions()[0]!.pending!, "deny");
    await w.drain();
    w.script([call("bash", { command: "echo deployed again >> deploy.log" }), say("Deployed.")]);
    await w.cli("send", "Deploy again.");
    await w.drain();
    w.advance(60 * 60_000);
    await w.dispatch();
    const asked = w.notes.filter((n) => n.title.includes("needs your answer"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toContain(`Answer at ${url}`);

    await server.stop();
    expect(w.agent.page.state()).toBeNull();
    expect(w.agent.page.notifying).toBe(0);
  });

  test("only the page itself can say it notifies: another site, or a request without fetch metadata, mutes nothing", async () => {
    const w = await world();
    const server = web(w.agent, () => () => {});
    const url = `http://127.0.0.1:${server.port}`;
    for (const headers of [{ "sec-fetch-site": "cross-site" }, {}] as Record<string, string>[]) {
      const tab = new AbortController();
      const res = await fetch(`${url}/events?notify=1`, { signal: tab.signal, headers });
      void res.body!.getReader().read().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(w.agent.page.state()).toEqual({ url, notifying: false });
      tab.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await server.stop();
  });

  test("stops promptly after tabs came and went, or while they are open", async () => {
    for (const closed of ["never", "just now", "a while ago"]) {
      const w = await world();
      const server = web(w.agent, () => () => {});
      const tabs = [new AbortController(), new AbortController()];
      for (const tab of tabs) {
        const res = await fetch(`http://127.0.0.1:${server.port}/events?notify=1`, {
          signal: tab.signal,
          headers: { "sec-fetch-site": "same-origin" },
        });
        await res.body!.getReader().read();
      }
      if (closed !== "never") for (const tab of tabs) tab.abort();
      if (closed === "a while ago") await new Promise((resolve) => setTimeout(resolve, 50));
      const deadline = new Promise((resolve) => setTimeout(() => resolve("hung"), 1000));
      expect(await Promise.race([server.stop().then(() => "stopped"), deadline])).toBe("stopped");
      expect(w.agent.page.notifying).toBe(0);
    }
  });
});
