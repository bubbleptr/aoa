import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime, countingTool } from "@aoa/conformance";
import type { PolicyContext } from "@aoa/kernel";
import { sqliteStore } from "@aoa/store-sqlite";
import { AwaitingApproval, createHost } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(o: { store?: ReturnType<typeof sqliteStore>; clock?: FakeClock } = {}) {
  const store = o.store ?? sqliteStore(":memory:");
  if (!o.store) opened.push(store);
  const clock = o.clock ?? new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  return { store, clock, host };
}

const say = (text: string, thread = "t1", key = text) => ({
  source: "user_message" as const,
  dedupeKey: key,
  payload: { text },
  thread,
  trusted: true,
});

test("append wakes the agent's worker: a started host runs the event without being nudged", async () => {
  const { host } = setup();
  const runtime = new ScriptedRuntime();
  const agent = host.agent({ name: "a", inbox: "in", runtime, debounceMs: 0 });
  host.start();
  agent.append(say("hi"));
  await runtime.started(1);
  await host.stop();
});

test("append refuses text for a session that waits on an approval, and appends nothing", async () => {
  const { host } = setup();
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1" }] }]);
  const agent = host.agent({ name: "a", inbox: "in", runtime, tools: [countingTool("deploy")], debounceMs: 0 });
  agent.append(say("deploy it"));
  await agent.step.worker();
  const before = agent.read.events().length;

  let thrown: unknown;
  try {
    agent.append(say("never mind", "t1", "second"), { refuseWhileAwaitingApproval: true });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(AwaitingApproval);
  expect((thrown as AwaitingApproval).pending.callId).toBe("call-1");
  expect(agent.read.events()).toHaveLength(before);
  // Without the option the text goes in, and the kernel takes it as the user's word on the call.
  expect(agent.append(say("never mind", "t1", "third")).status).toBe("pending");
});

test("answer: the first answer to a call counts, a second is dropped, and another agent's call is not this agent's to answer", async () => {
  const { host } = setup();
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1" }] }]);
  const a = host.agent({ name: "a", inbox: "in-a", runtime, tools: [countingTool("deploy")], debounceMs: 0 });
  const b = host.agent({ name: "b", inbox: "in-b", runtime: new ScriptedRuntime() });
  a.append(say("deploy it"));
  await a.step.worker();

  expect(() => b.answer("call-1", { verdict: "approve" })).toThrow(/call-1/);
  expect(a.answer("call-1", { verdict: "approve", via: "test" }).status).toBe("pending");
  expect(a.answer("call-1", { verdict: "deny" }).status).toBe("dropped");
});

test("read: sessions, their threads with the first one primary, the events, the runs and what was decided", async () => {
  const { host } = setup();
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1", args: { env: "prod" } }] }]);
  const agent = host.agent({ name: "a", inbox: "in", runtime, tools: [countingTool("deploy")], debounceMs: 0 });
  agent.append(say("deploy it"));
  await agent.step.worker();

  const [session] = agent.read.sessions();
  expect(agent.read.threads(session!.id)).toEqual(["t1"]);
  expect(agent.read.sessionFor("t1")).toBe(session!.id);
  expect(agent.read.sessionFor("nowhere")).toBeNull();
  expect(agent.read.events({ status: "done" }).map((e) => e.dedupeKey)).toEqual(["deploy it"]);
  expect(agent.read.events({ status: "pending" })).toEqual([]);
  expect(agent.read.pending().map((p) => p.callId)).toEqual(["call-1"]);
  expect(agent.read.runs().map((r) => r.end)).toEqual([{ kind: "deferred", callId: "call-1" }]);
  expect(agent.read.decisions(session!.id).map((d) => [d.callId, d.decision])).toEqual([["call-1", "defer"]]);
  expect(agent.read.journal(session!.id)).toEqual([]);
});

test("read.events pages forward: since is a receive time, limit keeps the first ones after it", async () => {
  const { host, clock } = setup();
  const agent = host.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  for (const text of ["one", "two", "three"]) {
    agent.append(say(text, `t-${text}`));
    clock.advance(10);
  }
  const first = agent.read.events()[0]!.receivedAt;
  expect(agent.read.events({ since: first + 1, limit: 1 }).map((e) => e.dedupeKey)).toEqual(["two"]);
});

test("schedule with the same id after a restart keeps one timer, and the occurrence it missed while down still fires", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const first = setup({ store, clock }).host.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  const id = first.schedule({ id: "daily", everyMs: 1000, anchor: clock.now() + 1000, payload: { job: "digest" } });

  clock.advance(1500);
  const again = setup({ store, clock }).host.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  expect(again.schedule({ id: "daily", everyMs: 1000, anchor: clock.now() - 500, payload: { job: "digest" } })).toBe(id);
  expect(again.read.timers()).toHaveLength(1);
  expect(again.step.scheduler().fired).toBe(1);
});

test("schedule with the same id and a new interval updates the timer; cancelTimer cancels only this agent's", async () => {
  const { host, clock } = setup();
  const a = host.agent({ name: "a", inbox: "in-a", runtime: new ScriptedRuntime() });
  const b = host.agent({ name: "b", inbox: "in-b", runtime: new ScriptedRuntime() });
  const anchor = clock.now();
  const id = a.schedule({ id: "daily", everyMs: 1000, anchor, payload: 1 });
  // Another agent's "daily" is its own timer.
  const other = b.schedule({ id: "daily", everyMs: 1000, anchor, payload: 1 });
  expect(other).not.toBe(id);

  a.schedule({ id: "daily", everyMs: 5000, anchor, payload: 2 });
  const [timer] = a.read.timers();
  expect(timer).toMatchObject({ id, recurrence: { everyMs: 5000, anchor }, payload: 2, status: "armed" });

  expect(b.cancelTimer(id)).toBe(false);
  expect(a.cancelTimer(id)).toBe(true);
  expect(a.cancelTimer(id)).toBe(false);
  expect(a.read.timers()[0]!.status).toBe("cancelled");
  // Scheduling it again arms it again.
  a.schedule({ id: "daily", everyMs: 5000, anchor, payload: 2 });
  expect(a.read.timers()[0]!.status).toBe("armed");
});

test("followUp wakes one of the agent's own sessions; another agent's session is refused", async () => {
  const { host, clock } = setup();
  const a = host.agent({ name: "a", inbox: "in-a", runtime: new ScriptedRuntime(), debounceMs: 0 });
  const b = host.agent({ name: "b", inbox: "in-b", runtime: new ScriptedRuntime() });
  a.append(say("hi"));
  await a.step.worker();
  const session = a.read.sessions()[0]!.id;

  expect(() => b.followUp({ sessionId: session, due: clock.now() + 10, payload: null })).toThrow(/session/);
  const id = a.followUp({ sessionId: session, due: clock.now() + 10, payload: { check: true } });
  expect(a.read.timers().map((t) => t.id)).toEqual([id]);
});

test("host.messages merges every agent's outbox in the order queued, pages from a message id, and names the agent", async () => {
  const { host } = setup();
  const notify = (callId: string, text: string) => ({ calls: [{ tool: "notify", callId, args: { body: text } }] });
  const a = host.agent({ name: "a", inbox: "in-a", runtime: new ScriptedRuntime([notify("n1", "from a")]), debounceMs: 0 });
  const b = host.agent({ name: "b", inbox: "in-b", runtime: new ScriptedRuntime([notify("n2", "from b")]), debounceMs: 0 });
  a.append(say("go"));
  await a.step.worker();
  b.append(say("go"));
  await b.step.worker();

  const all = host.messages();
  expect(all.map((m) => [m.agent, m.body])).toEqual([
    ["a", "from a"],
    ["b", "from b"],
  ]);
  expect(all[0]!.seq).toBeLessThan(all[1]!.seq);
  expect(all[0]!.sentAt).toBeNull();
  expect(host.messages({ since: all[0]!.id }).map((m) => m.agent)).toEqual(["b"]);
  expect(host.messages({ limit: 1 }).map((m) => m.agent)).toEqual(["a"]);
  expect(() => host.messages({ since: "nope" })).toThrow(/nope/);
});

test("the classifier can read the session it judges", async () => {
  const { host } = setup();
  const seen: string[][] = [];
  const classify = async (_call: unknown, ctx: PolicyContext) => {
    seen.push(ctx.read!.threads(ctx.call!.sessionId));
    return "allow" as const;
  };
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1" }] }]);
  const deploy = { ...countingTool("deploy"), risk: "medium" as const };
  const agent = host.agent({ name: "a", inbox: "in", runtime, tools: [deploy], policy: { classify }, debounceMs: 0 });
  agent.append(say("deploy it"));
  await agent.step.worker();
  expect(seen).toEqual([["t1"]]);
  expect(deploy.effects).toHaveLength(1);
});
