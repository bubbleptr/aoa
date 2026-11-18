import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addFollowUp } from "@aoa-dev/kernel";
import { Harness, storeFactories } from "../src/index.ts";

const MINUTE = 60_000;

for (const [name, factory] of storeFactories) {
  describe(`C8 a follow-up fires once and ends [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
      h.store.tx((t) => t.insertSession({ id: "session-1", inboxId: h.inboxId, createdAt: h.clock.now() }));
    });
    afterEach(() => h.dispose());

    test("it fires at its due time, ends done and never fires again", () => {
      const due = h.clock.now() + 5 * MINUTE;
      const timer = addFollowUp(h.store, h.inboxId, { sessionId: "session-1", due, payload: { note: "ping" } });
      const scheduler = h.scheduler();

      expect(scheduler.pass()).toEqual({ fired: 0, nextDueAt: due });
      h.clock.advance(5 * MINUTE);
      expect(scheduler.pass()).toEqual({ fired: 1, nextDueAt: null });
      expect(h.store.tx((t) => t.getTimer(timer.id))).toMatchObject({ status: "done", lastFired: due });

      h.clock.advance(60 * MINUTE);
      expect(scheduler.pass().fired).toBe(0);
      expect(h.timerEvents()).toHaveLength(1);
      expect(h.timerEvents()[0]).toMatchObject({
        dedupeKey: `${timer.id}:${due}`,
        payload: { note: "ping" },
        resume: "session-1",
        trusted: true,
        status: "pending",
      });
    });

    test("a cancelled follow-up never fires", () => {
      const timer = addFollowUp(h.store, h.inboxId, { sessionId: "session-1", due: h.clock.now() + MINUTE, payload: {} });
      expect(h.store.tx((t) => t.cancelTimersForSession("session-1"))).toBe(1);

      h.clock.advance(10 * MINUTE);
      expect(h.scheduler().pass()).toEqual({ fired: 0, nextDueAt: null });
      expect(h.store.tx((t) => t.getTimer(timer.id))?.status).toBe("cancelled");
      expect(h.timerEvents()).toHaveLength(0);
    });
  });
}
