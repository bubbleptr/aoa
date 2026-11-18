import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSchedule } from "../src/kernel.ts";
import { Harness, storeFactories } from "../src/index.ts";

const HOUR = 3_600_000;

for (const [name, factory] of storeFactories) {
  describe(`C9 a schedule stays on its grid [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("late passes do not shift later occurrences", () => {
      const anchor = h.clock.now() + HOUR;
      const timer = addSchedule(h.store, h.clock, h.inboxId, { everyMs: HOUR, anchor, payload: { job: "digest" } });
      const scheduler = h.scheduler();

      for (let k = 0; k < 4; k++) {
        // Each pass runs 7 minutes after the slot; adding everyMs to the fire time would drift by 7 minutes per round.
        h.clock.advance(anchor + k * HOUR + 7 * 60_000 - h.clock.now());
        expect(scheduler.pass().fired).toBe(1);
        expect(h.store.tx((t) => t.getTimer(timer.id))).toMatchObject({
          status: "armed",
          lastFired: anchor + k * HOUR,
          due: anchor + (k + 1) * HOUR,
        });
      }
      expect(h.timerEvents().map((e) => e.dedupeKey)).toEqual([0, 1, 2, 3].map((k) => `${timer.id}:${anchor + k * HOUR}`));
    });

    test("after a long gap one event is appended and due jumps to the next slot after now", () => {
      const anchor = h.clock.now() + HOUR;
      const timer = addSchedule(h.store, h.clock, h.inboxId, { everyMs: HOUR, anchor, payload: {} });

      h.clock.advance(HOUR + 10 * HOUR + 30 * 60_000);
      expect(h.scheduler().pass()).toEqual({ fired: 1, nextDueAt: anchor + 11 * HOUR });
      expect(h.timerEvents()).toHaveLength(1);
      expect(h.store.tx((t) => t.getTimer(timer.id))).toMatchObject({ due: anchor + 11 * HOUR, lastFired: anchor });
    });
  });
}
