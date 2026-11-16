import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SimulatedCrash, answerDeferred } from "@aoa/kernel";
import { FakeChannel, Harness, ScriptedRuntime, countingTool, crashAt, storeFactories, type RunScript } from "../src/index.ts";

const THREAD = "github:o/r#1";
const deployCall: RunScript = { calls: [{ tool: "deploy", callId: "call-1" }] };

for (const [name, factory] of storeFactories) {
  describe(`C20 one approval request per call [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test.each([
      ["approved", "/approve"],
      ["denied", "/deny not today"],
    ])("a deferring run that crashed and is rerun once %s asks once, and the user sees it once", async (_label, reply) => {
      const deploy = countingTool("deploy");
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      const worker = (o: object = {}) => h.worker({ runtime, tools: [deploy], policy: { risk: {} }, ...o });
      const channel = new FakeChannel();

      h.append({ thread: THREAD });
      await expect(worker({ crash: crashAt("before_complete") }).drain()).rejects.toBeInstanceOf(SimulatedCrash);
      h.waitOutLease();
      // The events are back to pending, but their session waits on the call: nothing runs until the answer.
      expect((await worker({ store: h.connect() }).drain()).runs).toBe(0);
      await h.dispatcher({ channel }).pass();

      h.append({ thread: THREAD, payload: { text: reply } });
      await worker({ store: h.connect() }).drain();
      await h.dispatcher({ channel }).pass();

      expect(runtime.runs).toHaveLength(2);
      expect(runtime.runs[1]!.input.events.map((e) => e.source)).toEqual(["user_message", "approval_answer"]);
      expect(h.outbox().filter((m) => m.kind === "approval_request")).toHaveLength(1);
      expect(channel.visible.map((m) => m.kind)).toEqual(["approval_request"]);
      expect(runtime.runs[1]!.toolResults).toHaveLength(1);
      expect(runtime.runs[1]!.toolResults[0]!.status).not.toBe("deferred");
    });

    test("a call answered before its request went out is never asked about", async () => {
      const runtime = new ScriptedRuntime([deployCall, {}]);
      const worker = h.worker({ runtime, tools: [countingTool("deploy")], policy: { risk: {} } });
      const channel = new FakeChannel();

      h.append({ thread: THREAD });
      await worker.drain();
      answerDeferred(h.store, h.clock, h.inboxId, "call-1", "approve");
      await h.dispatcher({ channel }).pass();

      expect(channel.visible).toEqual([]);
      expect(h.outbox().map((m) => [m.kind, m.status])).toEqual([["approval_request", "cancelled"]]);
    });
  });
}
