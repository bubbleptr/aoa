import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime } from "@aoa-dev/conformance";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createHost } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const say = (text: string, thread: string) => ({
  source: "user_message" as const,
  dedupeKey: text,
  payload: { text },
  thread,
  trusted: true,
});

function setup(scripts: ConstructorParameters<typeof ScriptedRuntime>[0]) {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const runtime = new ScriptedRuntime(scripts);
  const agent = host.agent({ name: "a", inbox: "in", runtime, debounceMs: 0 });
  return { agent, runtime };
}

test("aborting a session's run three times in a row never makes its events dead, and the next run takes them with the new one", async () => {
  const { agent, runtime } = setup([{ hang: true }, { hang: true }, { hang: true }, {}]);
  agent.append(say("start", "t"));
  const draining = agent.step.worker();
  for (let i = 1; i <= 3; i++) {
    await runtime.started(i);
    const session = agent.read.sessionFor("t")!;
    agent.append(say(`change ${i}`, "t"));
    expect(agent.abort(session)).toBe(true);
  }
  await draining;

  expect(agent.read.events({ status: "dead" })).toEqual([]);
  expect(agent.read.events({ status: "pending" })).toEqual([]);
  const last = runtime.runs[3]!.input.events.map((e) => (e.payload as { text: string }).text);
  expect(last).toEqual(["start", "change 1", "change 2", "change 3"]);
  expect(new Set(agent.read.runs().map((r) => r.sessionId)).size).toBe(1);
  expect(agent.read.runs().slice(0, 3).map((r) => r.error)).toEqual(Array(3).fill("interrupted: the run was aborted"));
});

test("abort touches only the run of the session it names", async () => {
  const { agent, runtime } = setup([{ hang: true }]);
  agent.append(say("start", "t"));
  const draining = agent.step.worker();
  await runtime.started(1);
  agent.append(say("other", "u"));
  await agent.step.worker(); // returns at once: the inbox's lease is held by the run in flight

  expect(agent.abort("no-such-session")).toBe(false);
  expect(runtime.runs[0]!.input.signal.aborted).toBe(false);
  expect(agent.abort(agent.read.sessionFor("t")!)).toBe(true);
  await draining;
});

test("abort with no run in flight is a no-op", () => {
  const { agent } = setup([]);
  expect(agent.abort("anything")).toBe(false);
});
