import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POLL_INTERVAL_MS, SimulatedCrash, type NewEvent } from "@aoa-dev/kernel";
import { FakeChannel, Harness, crashAt, storeFactories } from "../src/index.ts";

const comment = (n: number): NewEvent => ({
  source: "user_message",
  dedupeKey: `github:comment:${n}`,
  payload: { text: `comment ${n}` },
  thread: "github:o/r#1",
  trusted: true,
});

for (const [name, factory] of storeFactories) {
  describe(`channel poller [${name}]`, () => {
    let h: Harness;
    let channel: FakeChannel;
    beforeEach(() => {
      h = new Harness(factory());
      channel = new FakeChannel();
    });
    afterEach(() => h.dispose());

    test("a crash after polling stores neither events nor cursor; the next poll repeats it and accepts each event once", async () => {
      channel.push(comment(1), comment(2));
      await expect(h.poller({ channel, crash: crashAt("after_poll") }).pass()).rejects.toBeInstanceOf(SimulatedCrash);
      expect(h.events()).toEqual([]);

      let woken = 0;
      const poller = h.poller({ channel, store: h.connect(), onEvents: () => woken++ });
      expect(await poller.pass()).toEqual({ accepted: 2 });
      expect(channel.polls).toEqual([null, null]);
      expect(woken).toBe(1);

      channel.push(comment(3));
      expect(await poller.pass()).toEqual({ accepted: 1 });
      expect(await poller.pass()).toEqual({ accepted: 0 });
      expect(channel.polls).toEqual([null, null, "2", "3"]);
      expect(woken).toBe(2);
      expect(h.events().map((e) => e.dedupeKey)).toEqual(["github:comment:1", "github:comment:2", "github:comment:3"]);
    });

    test("an event the remote returns again is dropped by its dedupe key", async () => {
      channel.push(comment(1));
      await h.poller({ channel }).pass();
      channel.push(comment(1));
      expect(await h.poller({ channel }).pass()).toEqual({ accepted: 0 });
      expect(h.events().map((e) => e.status)).toEqual(["pending", "dropped"]);
    });

    test("serve polls every interval until stopped", async () => {
      const poller = h.poller({ channel });
      const serving = poller.serve();
      await h.clock.timerPending();
      channel.push(comment(1));
      h.clock.advance(POLL_INTERVAL_MS);
      await h.clock.timerPending();
      poller.stop();
      await serving;
      expect(channel.polls).toEqual([null, "0"]);
      expect(h.events()).toHaveLength(1);
    });
  });
}
