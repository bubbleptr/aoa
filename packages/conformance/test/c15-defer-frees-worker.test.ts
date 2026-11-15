import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness, ScriptedRuntime, countingTool, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C15 the worker keeps working while a call waits [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("an unrelated event is handled while a session is paused; its own new events wait for the answer", async () => {
      const deploy = countingTool("deploy");
      h.append({ thread: "task-a" });
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1" }] }]);
      const worker = h.worker({ runtime, tools: [deploy], policy: { risk: {} } });
      await worker.drain();
      const paused = runtime.runs[0]!.input.session.id;

      const other = h.append({ thread: "task-b" });
      const comment = h.append({ thread: "task-a", trusted: false, payload: { text: "looks good to me" } });
      expect(await worker.drain()).toEqual({ runs: 1, nextReadyAt: null });

      expect(runtime.runs[1]!.input.events.map((e) => e.id)).toEqual([other.id]);
      expect(runtime.runs[1]!.input.session.id).not.toBe(paused);
      expect(h.store.tx((t) => t.getEvent(comment.id))).toMatchObject({ status: "pending", resume: paused });
      expect(h.store.tx((t) => t.getSession(paused))?.status).toBe("paused");
    });
  });
}
