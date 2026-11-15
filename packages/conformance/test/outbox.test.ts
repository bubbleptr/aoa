import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEASE_MS, OUTBOX_MAX_ATTEMPTS, SimulatedCrash, outboxTools, type RatePolicy } from "@aoa/kernel";
import { FakeChannel, Harness, ScriptedRuntime, countingTool, crashAt, storeFactories, type ScriptedCall } from "../src/index.ts";

const MINUTE = 60_000;
const unpaced: RatePolicy = { maxMsgs: 1000, windowMs: MINUTE, minIntervalMs: 0 };

const notify = (callId: string, body: string): ScriptedCall => ({ tool: "notify", callId, args: { body } });

for (const [name, factory] of storeFactories) {
  describe(`outbox [${name}]`, () => {
    let h: Harness;
    let channel: FakeChannel;
    beforeEach(() => {
      h = new Harness(factory());
      channel = new FakeChannel();
    });
    afterEach(() => h.dispose());

    const tools = () => outboxTools({ store: h.store, clock: h.clock, inboxId: h.inboxId });

    test("notify executed again after a crash returns the same message instead of adding one", async () => {
      h.append({ thread: "task-1" });
      const script = { calls: [notify("call-1", "PR opened")] };
      const runtime = new ScriptedRuntime([script, script]);
      await expect(h.worker({ runtime, tools: tools(), crash: crashAt("after_tool_exec") }).drain()).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      h.clock.advance(LEASE_MS);
      await h.worker({ runtime, tools: tools(), store: h.connect() }).drain();

      expect(h.outbox()).toHaveLength(1);
      expect(runtime.runs[1]!.toolResults).toEqual([{ status: "ok", output: { msgId: h.outbox()[0]!.id } }]);
    });

    test("a failing first message holds back the later ones of its session, not those of other sessions", async () => {
      h.append({ thread: "task-a" });
      h.append({ thread: "task-b" });
      const runtime = new ScriptedRuntime([
        { calls: [notify("call-1", "a1"), notify("call-2", "a2")] },
        { calls: [notify("call-3", "b1")] },
      ]);
      await h.worker({ runtime, tools: tools() }).drain();
      const dispatcher = h.dispatcher({ channel, policy: unpaced });

      channel.failNext("before_accept");
      await dispatcher.pass();
      expect(channel.visible.map((m) => m.body)).toEqual(["b1"]);
      await dispatcher.pass();
      expect(channel.visible.map((m) => m.body)).toEqual(["b1"]);

      h.clock.advance(MINUTE);
      await dispatcher.pass();
      await dispatcher.pass();
      expect(channel.visible.map((m) => m.body)).toEqual(["b1", "a1", "a2"]);
    });

    test("failed deliveries back off 1, 2, 4, 8 minutes; the fifth failure is final, kept and listed", async () => {
      h.append({ thread: "task-a" });
      const runtime = new ScriptedRuntime([{ calls: [notify("call-1", "first"), notify("call-2", "second")] }]);
      await h.worker({ runtime, tools: tools() }).drain();
      const dispatcher = h.dispatcher({ channel, policy: unpaced });
      channel.failNext(...Array(OUTBOX_MAX_ATTEMPTS).fill("before_accept"));

      const start = h.clock.now();
      for (const wait of [1, 2, 4, 8]) {
        const { nextCheckAt } = await dispatcher.pass();
        expect(nextCheckAt).toBe(h.clock.now() + wait * MINUTE);
        h.clock.advance(wait * MINUTE - 1);
        await dispatcher.pass();
        h.clock.advance(1);
      }
      expect(channel.calls).toHaveLength(4);
      expect(h.clock.now() - start).toBe(15 * MINUTE);

      await dispatcher.pass();
      expect(channel.calls).toHaveLength(5);
      const failed = h.store.tx((t) => t.listFailed(h.inboxId));
      expect(failed).toMatchObject([{ body: "first", status: "failed", attempts: OUTBOX_MAX_ATTEMPTS }]);

      // A message that will never go out must not mute the rest of its session.
      await dispatcher.pass();
      expect(channel.visible.map((m) => m.body)).toEqual(["second"]);
      expect(channel.calls).toHaveLength(6);
    });

    test("an approval request waits behind a held message of its own session", async () => {
      h.append({ thread: "task-a" });
      const runtime = new ScriptedRuntime([{ calls: [notify("call-1", "starting the deploy"), { tool: "deploy", callId: "call-2" }] }]);
      await h.worker({ runtime, tools: [...tools(), countingTool("deploy")], policy: { risk: { notify: "low" } } }).drain();
      const quietAllDay: RatePolicy = { ...unpaced, quietPeriod: { startMinute: 0, endMinute: 24 * 60 } };

      await h.dispatcher({ channel, policy: quietAllDay }).pass();
      expect(channel.calls).toEqual([]);
      await h.dispatcher({ channel, policy: unpaced }).pass();
      await h.dispatcher({ channel, policy: unpaced }).pass();
      expect(channel.visible.map((m) => m.kind)).toEqual(["message", "approval_request"]);
    });

    test("serve delivers after a wake and goes back to sleep", async () => {
      const dispatcher = h.dispatcher({ channel });
      const serving = dispatcher.serve();
      await h.clock.timerPending();

      h.append({ thread: "task-a" });
      await h.worker({ runtime: new ScriptedRuntime([{ calls: [notify("call-1", "hello")] }]), tools: tools() }).drain();
      dispatcher.wake();
      await channel.seen(1);
      dispatcher.stop();
      await serving;
      expect(channel.visible.map((m) => m.body)).toEqual(["hello"]);
    });
  });
}
