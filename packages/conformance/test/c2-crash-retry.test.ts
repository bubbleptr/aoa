import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEASE_MS, MAX_ATTEMPTS, SimulatedCrash, retryDelayMs } from "../src/kernel.ts";
import { Harness, ScriptedRuntime, crashAt, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C2 a crashed run's events are picked up again [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    for (const point of ["after_claim", "before_complete"] as const) {
      test(`crash at ${point}: a fresh worker retries after the lease and the retry delay have passed`, async () => {
        const { id } = h.append();
        const runtime = new ScriptedRuntime();
        const dying = h.worker({ runtime, crash: crashAt(point) });
        await expect(dying.drain()).rejects.toBeInstanceOf(SimulatedCrash);
        expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("in_run");

        const fresh = h.worker({ runtime, store: h.connect() });
        expect((await fresh.drain()).runs).toBe(0);

        h.clock.advance(LEASE_MS);
        const expiredAt = h.clock.now();
        // A lease that ran out is a failed attempt, so the events wait out the retry delay (design §9).
        expect(await fresh.drain()).toEqual({ runs: 0, nextReadyAt: expiredAt + retryDelayMs(1) });

        h.clock.advance(retryDelayMs(1));
        expect((await fresh.drain()).runs).toBe(1);
        const event = h.store.tx((t) => t.getEvent(id))!;
        expect(event.status).toBe("done");
        expect(event.attempts).toBe(1);
        expect(runtime.runs.at(-1)!.input.events.map((e) => e.id)).toEqual([id]);
      });
    }

    test(`an event that fails ${MAX_ATTEMPTS} times is dead`, async () => {
      const { id } = h.append();
      const runtime = new ScriptedRuntime(Array.from({ length: MAX_ATTEMPTS }, () => ({ fail: new Error("model unavailable") })));
      const worker = h.worker({ runtime });

      let runs = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        runs += (await worker.drain()).runs;
        if (attempt < MAX_ATTEMPTS) h.clock.advance(retryDelayMs(attempt));
      }
      expect(runs).toBe(MAX_ATTEMPTS);
      const event = h.store.tx((t) => t.getEvent(id))!;
      expect(event.status).toBe("dead");
      expect(event.attempts).toBe(MAX_ATTEMPTS);
      expect(h.runs().map((r) => r.error)).toEqual(Array(MAX_ATTEMPTS).fill("model unavailable"));
      expect((await worker.drain()).runs).toBe(0);
    });

    test(`an event whose worker dies ${MAX_ATTEMPTS} times is dead`, async () => {
      const { id } = h.append();
      const runtime = new ScriptedRuntime();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await expect(h.worker({ runtime, crash: crashAt("after_claim") }).drain()).rejects.toBeInstanceOf(SimulatedCrash);
        h.waitOutLease(i + 1);
      }
      expect((await h.worker({ runtime }).drain()).runs).toBe(0);
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("dead");
    });
  });
}
