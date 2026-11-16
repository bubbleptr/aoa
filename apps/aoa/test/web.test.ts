import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { systemClock } from "@aoa/kernel";
import { sqliteStore } from "@aoa/store-sqlite";
import { validateConfig } from "../src/config.ts";
import type { Edge, Snapshot } from "../src/observe.ts";
import { SERVE_SEEN } from "../src/serve.ts";
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

  // A write the watch missed is found by the data_version check.
  await w.cli("send", "Third task.");
  w.advance(10_000);
  expect((await client.next()).flows).toEqual({ in: 1 });

  const snapshot = (await (await fetch(`http://127.0.0.1:${server.port}/snapshot`)).json()) as Snapshot;
  expect(snapshot.edges.in.total).toBe(3);
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
  other.tx((t) => t.setCursor(w.agent.inboxId, SERVE_SEEN, String(w.clock.now())));
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
