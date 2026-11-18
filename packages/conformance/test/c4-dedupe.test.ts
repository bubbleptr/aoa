import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendEvent } from "../src/kernel.ts";
import { Harness, ScriptedRuntime, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C4 a redelivered event is dropped [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("a duplicate pending event is dropped and joins no run", async () => {
      const first = h.append({ source: "webhook", dedupeKey: "delivery-1" });
      const second = h.append({ source: "webhook", dedupeKey: "delivery-1" });
      expect(first.status).toBe("pending");
      expect(second.status).toBe("dropped");

      const runtime = new ScriptedRuntime();
      expect((await h.worker({ runtime }).drain()).runs).toBe(1);
      expect(runtime.runs[0]!.input.events.map((e) => e.id)).toEqual([first.id]);
      expect(h.store.tx((t) => t.getEvent(second.id))?.status).toBe("dropped");
    });

    test("a redelivery after the event is done is dropped and starts no run", async () => {
      h.append({ source: "webhook", dedupeKey: "delivery-1" });
      const worker = h.worker({ runtime: new ScriptedRuntime() });
      await worker.drain();

      expect(h.append({ source: "webhook", dedupeKey: "delivery-1" }).status).toBe("dropped");
      expect((await worker.drain()).runs).toBe(0);
      expect(h.runs()).toHaveLength(1);
    });

    test("the same key from a different source, or in a different inbox, is a different event", () => {
      h.append({ source: "webhook", dedupeKey: "42" });
      expect(h.append({ source: "timer", dedupeKey: "42" }).status).toBe("pending");
      const other = appendEvent(
        { store: h.store, clock: h.clock, inboxId: "inbox-2" },
        { source: "webhook", dedupeKey: "42", payload: null, trusted: true },
      );
      expect(other.status).toBe("pending");
    });
  });
}
