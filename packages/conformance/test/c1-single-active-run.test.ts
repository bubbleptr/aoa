import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness, ScriptedRuntime, gate, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C1 at most one active run per inbox [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("two workers on one database never run the same inbox at once", async () => {
      // Distinct threads give five separate groups, so the second worker always has something it could claim.
      await Promise.all([1, 2, 3, 4, 5].map(async (i) => h.append({ thread: `thread-${i}` })));
      const hold = gate();
      const runtime = new ScriptedRuntime([1, 2, 3, 4, 5].map(() => ({ gate: hold.promise })));
      const a = h.worker({ runtime, store: h.connect() });
      const b = h.worker({ runtime, store: h.connect() });

      const drainA = a.drain();
      await runtime.started(1);
      const drainB = await b.drain();
      expect(drainB.runs).toBe(0);
      expect(runtime.active).toBe(1);

      hold.open();
      await Promise.all([drainA, b.drain()]);
      expect(runtime.maxActive).toBe(1);
      expect(h.runs()).toHaveLength(5);
      expect(h.events().map((e) => e.status)).toEqual(["done", "done", "done", "done", "done"]);
    });
  });
}
