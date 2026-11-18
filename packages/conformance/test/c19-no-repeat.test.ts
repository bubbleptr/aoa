import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirMemory, outboxTools } from "../src/kernel.ts";
import { FakeChannel, Harness, ScriptedRuntime, storeFactories, type RunScript } from "../src/index.ts";

const notify = (callId: string, body: string): RunScript => ({ calls: [{ tool: "notify", callId, args: { body } }] });

for (const [name, factory] of storeFactories) {
  describe(`C19 the agent knows what it already told the user [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("a message sent in one run is in the next run's resident context, once it was delivered; only the last five", async () => {
      const bodies = ["one", "two", "three", "four", "five", "six"].map((n) => `Update ${n}.`);
      const runtime = new ScriptedRuntime([...bodies.map((b, i) => notify(`call-${i}`, b)), notify("call-7", "Update seven."), {}, {}]);
      const worker = h.worker({
        runtime,
        tools: outboxTools({ store: h.store, clock: h.clock, inboxId: h.inboxId }),
        memory: dirMemory(h.memoryDir),
      });
      const channel = new FakeChannel();
      const dispatcher = h.dispatcher({ channel, policy: { maxMsgs: 100, windowMs: 1, minIntervalMs: 0 } });

      for (let i = 0; i < bodies.length; i++) {
        h.append({ thread: `task-${i}` });
        await worker.drain();
        await dispatcher.pass();
      }
      // Appended but not delivered: the user has not been told yet.
      h.append({ thread: "task-7" });
      await worker.drain();
      h.append({ thread: "task-0" });
      h.append({ thread: "task-x" });
      await worker.drain();

      const [resumed, fresh] = runtime.runs.slice(7).map((r) => r.input.resident);
      expect(runtime.runs[7]!.input.session.resumed).toBe(true);
      for (const resident of [resumed!, fresh!]) {
        expect(resident).not.toContain("Update seven.");
        expect(bodies.filter((b) => resident.includes(b))).toEqual(bodies.slice(1));
        expect(resident.indexOf("Update two.")).toBeLessThan(resident.indexOf("Update six."));
      }
    });
  });
}
