import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness, ScriptedRuntime, gate, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C5 appending never waits on a run [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("an append during a held run returns at once, durable, and waits for the next run", async () => {
      h.append();
      const hold = gate();
      const runtime = new ScriptedRuntime([{ gate: hold.promise }]);
      const draining = h.worker({ runtime }).drain();
      await runtime.started(1);

      const appended = h.append();
      expect(runtime.active).toBe(1);
      expect(appended.status).toBe("pending");
      const seenElsewhere = h.connect().tx((t) => t.getEvent(appended.id));
      expect(seenElsewhere?.status).toBe("pending");

      hold.open();
      expect((await draining).runs).toBe(2);
      expect(runtime.runs.map((r) => r.input.events.length)).toEqual([1, 1]);
      expect(runtime.runs[1]!.input.events[0]!.id).toBe(appended.id);
    });
  });
}
