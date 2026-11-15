import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addFollowUp, timerTools } from "@aoa/kernel";
import { Harness, ScriptedRuntime, storeFactories } from "../src/index.ts";

const MINUTE = 60_000;

for (const [name, factory] of storeFactories) {
  describe(`timers [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("a follow-up's event appears only once it is due, and resumes its session in the worker", async () => {
      h.append();
      const runtime = new ScriptedRuntime();
      const worker = h.worker({ runtime });
      await worker.drain();
      const session = runtime.runs[0]!.input.session.id;

      addFollowUp(h.store, h.inboxId, { sessionId: session, due: h.clock.now() + 30 * MINUTE, payload: { note: "check CI" } });
      let woken = 0;
      const scheduler = h.scheduler({ onFire: () => woken++ });

      h.clock.advance(30 * MINUTE - 1);
      scheduler.pass();
      expect(h.timerEvents()).toHaveLength(0);
      expect(woken).toBe(0);

      h.clock.advance(1);
      scheduler.pass();
      expect(woken).toBe(1);
      expect((await worker.drain()).runs).toBe(1);
      const rerun = runtime.runs[1]!.input;
      expect(rerun.session).toMatchObject({ id: session, resumed: true });
      expect(rerun.events.map((e) => [e.source, e.payload])).toEqual([["timer", { note: "check CI" }]]);
    });

    test("wake_me_at creates a follow-up for the calling session; only that session can cancel it", async () => {
      h.append({ thread: "task-1" });
      const tools = timerTools({ store: h.store, clock: h.clock, inboxId: h.inboxId });
      const runtime = new ScriptedRuntime([
        { calls: [{ tool: "wake_me_at", callId: "call-1", args: { inMs: 10 * MINUTE, note: "look at review" } }] },
      ]);
      await h.worker({ runtime, tools }).drain();

      const session = runtime.runs[0]!.input.session.id;
      const result = runtime.runs[0]!.toolResults[0];
      if (result?.status !== "ok") throw new Error(`wake_me_at failed: ${JSON.stringify(result)}`);
      const { timerId, due } = result.output as { timerId: string; due: string };
      expect(Date.parse(due)).toBe(h.clock.now() + 10 * MINUTE);
      expect(h.store.tx((t) => t.getTimer(timerId))).toMatchObject({
        kind: "follow_up",
        sessionId: session,
        status: "armed",
        payload: { note: "look at review" },
      });

      h.append({ thread: "task-2" });
      h.append({ thread: "task-1" });
      const cancel = (callId: string) => ({ calls: [{ tool: "cancel_wake", callId, args: { timerId } }] });
      const later = new ScriptedRuntime([cancel("call-2"), cancel("call-3")]);
      await h.worker({ runtime: later, tools }).drain();

      expect(later.runs.map((r) => r.input.session.id === session)).toEqual([false, true]);
      expect(later.runs.map((r) => r.toolResults[0])).toEqual([
        { status: "ok", output: { cancelled: false } },
        { status: "ok", output: { cancelled: true } },
      ]);
      expect(h.store.tx((t) => t.getTimer(timerId))?.status).toBe("cancelled");
    });

    test("serve fires a timer when it comes due and calls onFire", async () => {
      h.store.tx((t) => t.insertSession({ id: "session-1", inboxId: h.inboxId, createdAt: h.clock.now() }));
      addFollowUp(h.store, h.inboxId, { sessionId: "session-1", due: h.clock.now() + 30_000, payload: {} });
      let fired!: () => void;
      const onFire = new Promise<void>((resolve) => (fired = resolve));
      const scheduler = h.scheduler({ onFire: () => fired() });
      const serving = scheduler.serve();

      await h.clock.timerPending();
      h.clock.advance(30_000);
      await onFire;
      scheduler.stop();
      await serving;
      expect(h.timerEvents()).toHaveLength(1);
    });
  });
}
