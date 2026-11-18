import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SimulatedCrash, addFollowUp, addSchedule } from "@aoa-dev/kernel";
import { Harness, crashAt, storeFactories } from "../src/index.ts";

const MINUTE = 60_000;

for (const [name, factory] of storeFactories) {
  describe(`C7 one event per timer occurrence [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    function dueTimers() {
      const now = h.clock.now();
      const session = h.store.tx((t) => {
        t.insertSession({ id: "session-1", inboxId: h.inboxId, createdAt: now });
        return "session-1";
      });
      addFollowUp(h.store, h.inboxId, { sessionId: session, due: now + MINUTE, payload: { note: "check" } });
      addSchedule(h.store, h.clock, h.inboxId, { everyMs: 10 * MINUTE, anchor: now + MINUTE, payload: {} });
      h.clock.advance(MINUTE);
    }

    test("a second pass at the same time fires nothing", () => {
      dueTimers();
      const scheduler = h.scheduler();
      expect(scheduler.pass().fired).toBe(2);
      expect(scheduler.pass().fired).toBe(0);
      expect(h.timerEvents()).toHaveLength(2);
    });

    test("two schedulers that saw the same due timers fire each occurrence once", () => {
      dueTimers();
      const b = h.scheduler({ store: h.connect() });
      let bFired = 0;
      // A has already listed both due timers when B runs a whole pass between A's first and second timer.
      const a = h.scheduler({
        store: h.connect(),
        crash: () => {
          if (bFired === 0) bFired = b.pass().fired;
        },
      });
      const aFired = a.pass().fired;
      expect([aFired, bFired]).toEqual([1, 1]);
      expect(h.timerEvents()).toHaveLength(2);
    });

    test("a scheduler that dies after firing one timer, then a fresh one, leave one event per occurrence", () => {
      dueTimers();
      expect(() => h.scheduler({ crash: crashAt("after_timer_fire") }).pass()).toThrow(SimulatedCrash);
      expect(h.timerEvents()).toHaveLength(1);

      expect(h.scheduler({ store: h.connect() }).pass().fired).toBe(1);
      const keys = h.timerEvents().map((e) => e.dedupeKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
    });
  });
}
