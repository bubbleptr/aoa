import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime } from "@aoa/conformance";
import { appendEvent, type Tx } from "@aoa/kernel";
import { sqliteStore } from "@aoa/store-sqlite";
import { createHost } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

test("a loop that dies stops the host, so a host with a dead worker does not keep running", async () => {
  const real = sqliteStore(":memory:");
  opened.push(real);
  let broken = false;
  const clock = new FakeClock();
  const store = {
    ...real,
    tx: <T>(fn: (t: Tx) => T): T => {
      if (broken) throw new Error("disk gone");
      return real.tx(fn);
    },
  };
  const lines: string[] = [];
  const host = createHost({ store, clock, log: (l) => lines.push(l) });
  host.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  host.start();

  broken = true;
  clock.advance(60_000);
  await host.stopped;
  expect(lines.some((l) => /^the (worker|scheduler) stopped: disk gone$/.test(l))).toBe(true);
});

test("stop() ends a run that would otherwise never finish", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const runtime = new ScriptedRuntime([{ hang: true }]);
  host.agent({ name: "a", inbox: "in", runtime, debounceMs: 0 });
  appendEvent({ store, clock, inboxId: "in" }, { source: "user_message", dedupeKey: "m1", payload: { text: "go" }, thread: "t", trusted: true });
  host.start();
  await runtime.started(1);

  await host.stop();
  expect(runtime.runs[0]!.input.signal.aborted).toBe(true);
});

test("a host runs once: starting it again is an error", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const host = createHost({ store, clock: new FakeClock(), log: () => {} });
  host.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  host.start();
  expect(() => host.start()).toThrow(/once/);
  await host.stop();
  expect(() => host.start()).toThrow(/once/);
});
