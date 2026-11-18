import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime, gate } from "@aoa-dev/conformance";
import { appendEvent, type Session } from "@aoa-dev/kernel";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createHost, type AgentSpec } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** One agent with a working directory per session; `cleanup` and `prepare` are recorded, and `cleanup` can be held. */
function setup(scripts: ConstructorParameters<typeof ScriptedRuntime>[0] = []) {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const calls: string[] = [];
  let holdCleanup: Promise<void> | null = null;
  const session: AgentSpec["session"] = {
    prepare: async (s: Session) => {
      calls.push(`prepare ${s.id}`);
      return { workdir: `/work/${s.id}` };
    },
    cleanup: async (s: Session, workdir: string) => {
      calls.push(`cleanup ${s.id} ${workdir}`);
      await holdCleanup;
      calls.push(`cleaned ${s.id}`);
    },
  };
  const runtime = new ScriptedRuntime(scripts);
  const agent = host.agent({ name: "a", inbox: "in", runtime, session, debounceMs: 0 });
  const other = host.agent({ name: "b", inbox: "other", runtime: new ScriptedRuntime(), session, debounceMs: 0 });
  const send = (text: string, n: number) =>
    appendEvent({ store, clock, inboxId: "in" }, { source: "user_message", dedupeKey: `m${n}`, payload: { text }, thread: "t", trusted: true });
  const sessionNow = () => store.tx((t) => t.listSessions("in"))[0]!;
  return { store, runtime, agent, other, calls, send, sessionNow, hold: (p: Promise<void>) => (holdCleanup = p) };
}

test("closing an idle session closes it, clears its directory and cleans it up", async () => {
  const w = setup();
  w.send("start", 1);
  await w.agent.step.worker();
  const { id } = w.sessionNow();

  const order: string[] = [];
  const result = await w.agent.closeSession(id, { afterClose: () => order.push(`closed ${w.sessionNow().status}`) });

  expect(result).toBe("closed");
  expect(w.sessionNow()).toMatchObject({ status: "closed", workdir: null });
  expect(order).toEqual(["closed closed"]);
  expect(w.calls).toEqual([`prepare ${id}`, `cleanup ${id} /work/${id}`, `cleaned ${id}`]);
});

test("closing a session while its run is in flight changes nothing and says so", async () => {
  const held = gate();
  const w = setup([{ gate: held.promise }]);
  w.send("start", 1);
  const draining = w.agent.step.worker();
  await w.runtime.started(1);
  const { id } = w.sessionNow();

  let after = false;
  expect(await w.agent.closeSession(id, { afterClose: () => (after = true) })).toBe("busy");
  expect(after).toBe(false);
  expect(w.sessionNow()).toMatchObject({ status: "open", workdir: `/work/${id}` });

  held.open();
  await draining;
  expect(w.calls).toEqual([`prepare ${id}`]);
});

test("a session reopened while its cleanup runs is prepared only after the cleanup ends", async () => {
  const w = setup();
  w.send("start", 1);
  await w.agent.step.worker();
  const { id } = w.sessionNow();

  const held = gate();
  w.hold(held.promise);
  const closing = w.agent.closeSession(id);
  w.send("one more", 2);
  const draining = w.agent.step.worker();
  held.open();
  await Promise.all([closing, draining]);
  expect(w.calls).toEqual([`prepare ${id}`, `cleanup ${id} /work/${id}`, `cleaned ${id}`, `prepare ${id}`]);
  expect(w.sessionNow()).toMatchObject({ status: "open", workdir: `/work/${id}` });
});

test("an agent closes only its own sessions", async () => {
  const w = setup();
  w.send("start", 1);
  await w.agent.step.worker();
  const { id } = w.sessionNow();

  await expect(w.other.closeSession(id)).rejects.toThrow(/no session/i);
  await expect(w.agent.closeSession("missing")).rejects.toThrow(/no session/i);
  expect(w.sessionNow()).toMatchObject({ status: "open", workdir: `/work/${id}` });
});
