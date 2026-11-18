import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_ATTEMPTS, SimulatedCrash, retryDelayMs, type Worker } from "@aoa/kernel";
import { FakeChannel, Harness, ScriptedRuntime, crashAt, storeFactories } from "../src/index.ts";

const failing = (n: number, message: string) => Array.from({ length: n }, () => ({ fail: new Error(message) }));

for (const [name, factory] of storeFactories) {
  describe(`a task that dies tells the user [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    const deadMessages = () => h.outbox().filter((m) => m.dedupeKey.startsWith("dead:"));

    /** One drain per attempt, waiting out the retry delay between them (design §9). */
    const drainThroughRetries = async (worker: Worker) => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await worker.drain();
        if (attempt < MAX_ATTEMPTS) h.clock.advance(retryDelayMs(attempt));
      }
    };

    test(`${MAX_ATTEMPTS} failed runs leave exactly one message, delivered once`, async () => {
      const { id } = h.append({ thread: "issue-1" });
      const runtime = new ScriptedRuntime(failing(MAX_ATTEMPTS, `model unavailable ${"x".repeat(600)}`));
      await drainThroughRetries(h.worker({ runtime }));

      const session = runtime.runs[0]!.input.session.id;
      const [msg, ...rest] = deadMessages();
      expect(rest).toEqual([]);
      expect(msg).toMatchObject({ kind: "message", thread: "issue-1", sessionId: session, dedupeKey: `dead:${session}:${id}` });
      expect(msg!.body).toContain("repeated failures");
      expect(msg!.body).toContain("model unavailable");
      expect(msg!.body).not.toContain("aoa status");
      expect(msg!.body).not.toContain("x".repeat(501));

      const channel = new FakeChannel();
      await h.dispatcher({ channel }).pass();
      await h.dispatcher({ channel }).pass();
      expect(channel.calls.map((m) => m.dedupeKey)).toEqual([`dead:${session}:${id}`]);
    });

    test("a run that loses its lease for the last time leaves the message too", async () => {
      const { id } = h.append({ thread: "issue-1" });
      const runtime = new ScriptedRuntime();
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await expect(h.worker({ runtime, crash: crashAt("after_claim") }).drain()).rejects.toBeInstanceOf(SimulatedCrash);
        h.waitOutLease(i + 1);
      }
      expect(deadMessages()).toEqual([]);
      await h.worker({ runtime }).drain();

      const session = h.runs()[0]!.sessionId;
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("dead");
      expect(deadMessages().map((m) => [m.dedupeKey, m.thread])).toEqual([[`dead:${session}:${id}`, "issue-1"]]);
    });

    test("a later successful run of the same session does not repeat it or count it as its own", async () => {
      h.append({ thread: "issue-1" });
      const runtime = new ScriptedRuntime([...failing(MAX_ATTEMPTS, "boom"), {}]);
      const worker = h.worker({ runtime });
      await drainThroughRetries(worker);
      h.append({ thread: "issue-1" });
      await worker.drain();

      expect(runtime.runs.at(-1)!.input.session.id).toBe(runtime.runs[0]!.input.session.id);
      expect(deadMessages()).toHaveLength(1);
      expect(h.runs().at(-1)!.end).toEqual({ kind: "silent" });
    });

    test("a session without a thread still records the message", async () => {
      h.append();
      await drainThroughRetries(h.worker({ runtime: new ScriptedRuntime(failing(MAX_ATTEMPTS, "boom")) }));
      expect(deadMessages().map((m) => m.thread)).toEqual([null]);
    });
  });
}
