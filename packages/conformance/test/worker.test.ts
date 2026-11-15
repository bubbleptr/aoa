import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEASE_MS } from "@aoa/kernel";
import { Harness, ScriptedRuntime, gate, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`worker [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("a run that outlives LEASE keeps its events while it renews", async () => {
      const { id } = h.append();
      const hold = gate();
      const runtime = new ScriptedRuntime([{ gate: hold.promise }]);
      const draining = h.worker({ runtime }).drain();
      await runtime.started(1);

      h.clock.advance(3 * LEASE_MS);
      expect((await h.worker({ runtime, store: h.connect() }).drain()).runs).toBe(0);
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "in_run", attempts: 0 });

      hold.open();
      await draining;
      expect(runtime.runs).toHaveLength(1);
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("done");
    });

    test("debounce holds a group until its newest event is old enough, and reports when", async () => {
      const runtime = new ScriptedRuntime();
      const worker = h.worker({ runtime, debounceMs: 2000 });
      h.append();
      h.clock.advance(1500);
      h.append();

      expect(await worker.drain()).toEqual({ runs: 0, nextReadyAt: h.clock.now() + 2000 });
      h.clock.advance(2000);
      expect((await worker.drain()).runs).toBe(1);
      expect(runtime.runs[0]!.input.events).toHaveLength(2);
    });

    test("serve drains on wake and when a debounced group becomes ready", async () => {
      const runtime = new ScriptedRuntime();
      const worker = h.worker({ runtime, debounceMs: 2000 });
      const serving = worker.serve();

      h.append();
      worker.wake();
      await h.clock.timerPending();
      expect(runtime.runs).toHaveLength(0);

      h.clock.advance(2000);
      await runtime.started(1);
      worker.stop();
      await serving;
      expect(h.events().map((e) => e.status)).toEqual(["done"]);
    });

    test("the worker reports each run's start and its recorded end, including a failure", async () => {
      const seen: string[] = [];
      const runtime = new ScriptedRuntime([{ fail: new Error("model down") }, {}]);
      const worker = h.worker({
        runtime,
        onRunStart: (r) => seen.push(`start ${r.runId} ${r.events}`),
        onRunEnd: (r) => seen.push(`end ${r.runId} ${r.end?.kind ?? r.error}`),
      });
      h.append();
      await worker.drain();

      const [first, second] = h.runs().map((r) => r.id);
      expect(seen).toEqual([`start ${first} 1`, `end ${first} model down`, `start ${second} 1`, `end ${second} silent`]);
    });
  });
}
