import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, ScriptedRuntime } from "@aoa-dev/conformance";
import { systemClock, type RunOutcome, type ToolDef } from "../src/kernel/index.ts";
import { sqliteStore } from "../src/index.ts";
import { createHost, followTool } from "../src/index.ts";

const opened: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const say = (text: string, thread = "t1", key = text) => ({
  source: "user_message" as const,
  dedupeKey: key,
  payload: { text },
  thread,
  trusted: true,
});

test("read: session lookup, sessionId/thread filters on events and runs, outbox and recentSent, and host.snapshot + beat", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const notify = (callId: string, body: string) => ({ calls: [{ tool: "notify", callId, args: { body } }] });
  const a = host.agent({ name: "a", inbox: "in-a", runtime: new ScriptedRuntime([notify("n1", "done a"), notify("n2", "done b")]), debounceMs: 0 });
  const b = host.agent({ name: "b", inbox: "in-b", runtime: new ScriptedRuntime(), debounceMs: 0 });

  expect(host.beat()).toBeNull();
  a.append(say("first", "t-1"));
  a.append(say("second", "t-2"));
  await a.step.worker();

  const [s1, s2] = a.read.sessions();
  expect(a.read.session(s1!.id)?.id).toBe(s1!.id);
  expect(b.read.session(s1!.id)).toBeNull();
  expect(a.read.events({ sessionId: s1!.id }).map((e) => e.dedupeKey)).toEqual(["first"]);
  expect(a.read.events({ thread: "t-2" }).map((e) => e.dedupeKey)).toEqual(["second"]);
  expect(a.read.runs({ sessionId: s2!.id })).toHaveLength(1);
  expect(a.read.outbox({ sessionId: s1!.id, status: "sent" }).map((m) => m.body)).toEqual(["done a"]);
  expect(a.read.recentSent(1).map((m) => m.body)).toEqual(["done b"]);

  const snap = host.snapshot(() => ({
    sessions: a.read.sessions().length,
    outbox: a.read.outbox().length,
  }));
  expect(snap).toEqual({ sessions: 2, outbox: 2 });
});

test("agent.follow and followTool bind extra threads to the calling session and refuse another session's thread", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "follow", callId: "f1", args: { thread: "pr:1" } }] }, {}]);
  const a = host.agent({ name: "a", inbox: "in-a", runtime, tools: [followTool(host)], debounceMs: 0 });

  a.append(say("open pr", "issue:1"));
  a.append(say("other task", "issue:2"));
  await a.step.worker();

  const s1 = a.read.sessionFor("issue:1")!;
  const s2 = a.read.sessionFor("issue:2")!;
  expect(a.read.sessionFor("pr:1")).toBe(s1);
  expect(a.read.threads(s1)).toEqual(["issue:1", "pr:1"]);

  a.follow(s1, "pr:2");
  expect(a.read.sessionFor("pr:2")).toBe(s1);
  expect(() => a.follow(s2, "pr:1")).toThrow(/another/);
});

test("ToolExecContext exposes inboxId, runId, now and read; onRunEnd can close the session right as the run settles", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  let seenCtx: unknown = null;
  const inspect: ToolDef = {
    name: "inspect",
    risk: "low",
    description: "inspects context",
    schema: { type: "object" },
    async execute(_args, ctx) {
      seenCtx = { inboxId: ctx.inboxId, runId: ctx.runId, now: ctx.now?.(), sessions: ctx.read?.sessions().length };
      return { ok: true };
    },
  };

  const outcomes: RunOutcome[] = [];
  const agent = host.agent({
    name: "a",
    inbox: "in-a",
    runtime: new ScriptedRuntime([{ calls: [{ tool: "inspect", callId: "c1" }] }]),
    tools: [inspect],
    debounceMs: 0,
    onRunEnd: async (r) => {
      outcomes.push(r);
      const closed = await agent.closeSession(r.sessionId);
      expect(closed).toBe("closed");
    },
  });

  clock.advance(42);
  agent.append(say("check"));
  await agent.step.worker();

  const [run] = agent.read.runs();
  expect(seenCtx).toEqual({ inboxId: "in-a", runId: run!.id, now: clock.now(), sessions: 1 });
  expect(outcomes).toHaveLength(1);
  expect(agent.read.sessions()[0]!.status).toBe("closed");
});

test("agent.abort from another process stops the serving host's in-flight run without dead-lettering its events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aoa-abort-"));
  dirs.push(dir);
  const db = join(dir, "aoa.db");
  const store = sqliteStore(db);
  const host = createHost({ store, clock: systemClock, log: () => {} });
  opened.push(host);
  const runtime = new ScriptedRuntime([{ hang: true }, {}]);
  const agent = host.agent({ name: "a", inbox: "in", runtime, debounceMs: 0 });
  agent.append(say("start", "t"));
  host.start();
  await runtime.started(1);
  const sessionId = agent.read.sessionFor("t")!;

  const script = `
    import { sqliteStore } from "../src/index.ts";
    import { createHost } from "../src/index.ts";
    const store = sqliteStore(${JSON.stringify(db)});
    const host = createHost({ store, log: () => {} });
    const agent = host.agent({ name: "a", inbox: "in", runtime: { kind: "kernel", run: async () => ({ end: { kind: "silent" } }) } });
    agent.append({ source: "user_message", dedupeKey: "followup", payload: { text: "updated" }, thread: "t", trusted: true });
    const aborted = agent.abort(${JSON.stringify(sessionId)});
    host.close();
    if (!aborted) process.exit(2);
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());

  await runtime.started(2);
  while (agent.read.events({ status: "pending" }).length > 0 || agent.read.events({ status: "in_run" }).length > 0) {
    await Bun.sleep(10);
  }
  await host.stop();

  expect(agent.read.events({ status: "dead" })).toEqual([]);
  expect(runtime.runs[1]!.input.events.map((e) => (e.payload as { text: string }).text)).toEqual(["start", "updated"]);
  expect(agent.read.runs()[0]!.error).toBe("interrupted: the run was aborted");
}, 10_000);
