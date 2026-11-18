import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SimulatedCrash, outboxTools } from "@aoa-dev/kernel";
import { FakeChannel, Harness, ScriptedRuntime, crashAt, storeFactories } from "../src/index.ts";

const MINUTE = 60_000;

for (const [name, factory] of storeFactories) {
  describe(`C17 a message is seen at most once [${name}]`, () => {
    let h: Harness;
    let channel: FakeChannel;
    beforeEach(async () => {
      h = new Harness(factory());
      channel = new FakeChannel();
      h.append({ thread: "github:o/r#1" });
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "notify", callId: "call-1", args: { body: "PR opened" } }] }]);
      await h.worker({ runtime, tools: outboxTools({ store: h.store, clock: h.clock, inboxId: h.inboxId }) }).drain();
    });
    afterEach(() => h.dispose());

    test("a delivery that errors after the channel accepted it is retried under the same key and shown once", async () => {
      channel.failNext("after_accept");
      await h.dispatcher({ channel }).pass();
      expect(h.outbox()).toMatchObject([{ status: "pending", attempts: 1 }]);

      h.clock.advance(MINUTE);
      await h.dispatcher({ channel }).pass();
      expect(h.outbox()).toMatchObject([{ status: "sent", attempts: 1 }]);
      expect(channel.calls).toHaveLength(2);
      expect(new Set(channel.calls.map((m) => m.dedupeKey)).size).toBe(1);
      expect(channel.visible.map((m) => [m.body, m.thread])).toEqual([["PR opened", "github:o/r#1"]]);
    });

    test("a crash between delivering and marking it sent: the restarted dispatcher redelivers it, shown once", async () => {
      await expect(h.dispatcher({ channel, crash: crashAt("after_deliver") }).pass()).rejects.toBeInstanceOf(SimulatedCrash);
      expect(h.outbox()).toMatchObject([{ status: "sending" }]);

      await h.dispatcher({ channel, store: h.connect() }).pass();
      expect(h.outbox()).toMatchObject([{ status: "sent" }]);
      expect(channel.calls).toHaveLength(2);
      expect(channel.visible).toHaveLength(1);
    });
  });
}
