import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SimulatedCrash, outboxTools } from "@aoa/kernel";
import { FakeChannel, Harness, ScriptedRuntime, crashAt, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C18 a run with nothing to say sends nothing [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    const tools = () => outboxTools({ store: h.store, clock: h.clock, inboxId: h.inboxId });

    test("a run that appends nothing ends silent, and the dispatcher delivers nothing", async () => {
      h.append();
      await h.worker({ runtime: new ScriptedRuntime(), tools: tools() }).drain();
      const channel = new FakeChannel();
      await h.dispatcher({ channel }).pass();

      expect(h.runs().map((r) => r.end)).toEqual([{ kind: "silent" }]);
      expect(h.outbox()).toEqual([]);
      expect(channel.calls).toEqual([]);
    });

    test("a run that notified ends sent with its message, also when it completes only on a rerun", async () => {
      h.append();
      const notify = { calls: [{ tool: "notify", callId: "call-1", args: { body: "done" } }] };
      const runtime = new ScriptedRuntime([notify, notify]);
      await expect(
        h.worker({ runtime, tools: tools(), crash: crashAt("before_complete") }).drain(),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      h.waitOutLease();
      await h.worker({ runtime, tools: tools(), store: h.connect() }).drain();

      const [msg] = h.outbox();
      expect(h.outbox()).toHaveLength(1);
      expect(h.runs().map((r) => r.end)).toEqual([null, { kind: "sent", msgs: [msg!.id] }]);
    });
  });
}
