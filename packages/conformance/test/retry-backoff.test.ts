import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEASE_MS, SimulatedCrash } from "@aoa/kernel";
import { Harness, ScriptedRuntime, crashAt, storeFactories } from "../src/index.ts";

/** The two delays of design §9: after the first failed attempt, after the second. */
const FIRST_DELAY_MS = 30_000;
const SECOND_DELAY_MS = 120_000;

const fail = (message: string) => ({ fail: new Error(message) });

for (const [name, factory] of storeFactories) {
  describe(`a failed run backs off before its events are retried [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test(`after the first failure the events wait ${FIRST_DELAY_MS / 1000} seconds`, async () => {
      const { id } = h.append();
      const runtime = new ScriptedRuntime([fail("model down"), {}]);
      const worker = h.worker({ runtime });

      const failedAt = h.clock.now();
      expect(await worker.drain()).toEqual({ runs: 1, nextReadyAt: failedAt + FIRST_DELAY_MS });
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "pending", attempts: 1 });

      h.clock.advance(FIRST_DELAY_MS - 1);
      expect(await worker.drain()).toEqual({ runs: 0, nextReadyAt: failedAt + FIRST_DELAY_MS });
      expect(runtime.runs).toHaveLength(1);

      h.clock.advance(1);
      expect((await worker.drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "done", attempts: 1 });
      expect(runtime.runs.at(-1)!.input.events.map((e) => e.id)).toEqual([id]);
    });

    test(`after the second failure the events wait ${SECOND_DELAY_MS / 60_000} minutes`, async () => {
      const { id } = h.append();
      const runtime = new ScriptedRuntime([fail("model down"), fail("model down"), {}]);
      const worker = h.worker({ runtime });

      expect((await worker.drain()).runs).toBe(1);
      h.clock.advance(FIRST_DELAY_MS);
      const secondFailureAt = h.clock.now();
      expect(await worker.drain()).toEqual({ runs: 1, nextReadyAt: secondFailureAt + SECOND_DELAY_MS });
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "pending", attempts: 2 });

      h.clock.advance(SECOND_DELAY_MS - 1);
      expect((await worker.drain()).runs).toBe(0);

      h.clock.advance(1);
      expect((await worker.drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("done");
    });

    test("another session's event runs while one session waits out its delay", async () => {
      const a = h.append({ thread: "task-a" });
      const runtime = new ScriptedRuntime([fail("model down"), {}]);
      const worker = h.worker({ runtime });

      expect((await worker.drain()).runs).toBe(1);
      const b = h.append({ thread: "task-b" });

      expect((await worker.drain()).runs).toBe(1);
      expect(runtime.runs.at(-1)!.input.events.map((e) => e.id)).toEqual([b.id]);
      expect(h.store.tx((t) => t.getEvent(b.id))?.status).toBe("done");
      expect(h.store.tx((t) => t.getEvent(a.id))?.status).toBe("pending");
    });

    test("a later event of the same session waits behind the delayed ones", async () => {
      const a = h.append({ thread: "task" });
      const runtime = new ScriptedRuntime([fail("model down"), {}]);
      const worker = h.worker({ runtime });

      expect((await worker.drain()).runs).toBe(1);
      const b = h.append({ thread: "task" });

      expect((await worker.drain()).runs).toBe(0);
      h.clock.advance(FIRST_DELAY_MS);
      expect((await worker.drain()).runs).toBe(1);
      expect(runtime.runs.at(-1)!.input.events.map((e) => e.id)).toEqual([a.id, b.id]);
      expect([a.id, b.id].map((id) => h.store.tx((t) => t.getEvent(id))?.status)).toEqual(["done", "done"]);
    });

    test("the delay is kept by the store, so a restart of serve does not retry early", async () => {
      const { id } = h.append();
      const failedAt = h.clock.now();
      await h.worker({ runtime: new ScriptedRuntime([fail("model down")]) }).drain();
      h.restart();

      const runtime = new ScriptedRuntime([{}]);
      h.clock.advance(FIRST_DELAY_MS - 1);
      expect(await h.worker({ runtime, store: h.connect() }).drain()).toEqual({
        runs: 0,
        nextReadyAt: failedAt + FIRST_DELAY_MS,
      });
      expect(runtime.runs).toHaveLength(0);

      h.clock.advance(1);
      expect((await h.worker({ runtime, store: h.connect() }).drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("done");
    });

    test("a lease that ran out delays the next attempt too", async () => {
      const { id } = h.append({ thread: "task" });
      const runtime = new ScriptedRuntime([{}]);
      await expect(h.worker({ runtime, crash: crashAt("after_claim") }).drain()).rejects.toBeInstanceOf(SimulatedCrash);

      h.clock.advance(LEASE_MS);
      const expiredAt = h.clock.now();
      const fresh = h.worker({ runtime, store: h.connect() });
      expect(await fresh.drain()).toEqual({ runs: 0, nextReadyAt: expiredAt + FIRST_DELAY_MS });

      h.clock.advance(FIRST_DELAY_MS);
      expect((await fresh.drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "done", attempts: 1 });
    });

    test("a serving worker wakes by itself when the delay ends", async () => {
      const runtime = new ScriptedRuntime([fail("model down"), {}]);
      const worker = h.worker({ runtime });
      const serving = worker.serve();

      const failedAt = h.clock.now();
      h.append();
      worker.wake();
      await runtime.started(1);
      await h.clock.timerDueBy(failedAt + FIRST_DELAY_MS);

      h.clock.advance(FIRST_DELAY_MS - 1);
      expect(runtime.runs).toHaveLength(1);

      h.clock.advance(1);
      await runtime.started(2);
      worker.stop();
      await serving;
      expect(h.events().map((e) => e.status)).toEqual(["done"]);
    });
  });
}
