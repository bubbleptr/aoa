import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness, ScriptedRuntime, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C6 pending events are batched by session [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("three messages in a row become one run", async () => {
      const ids = [h.append(), h.append(), h.append()].map((r) => r.id);
      const runtime = new ScriptedRuntime([{ end: { kind: "sent", msgs: ["reply-1"] } }]);

      expect((await h.worker({ runtime }).drain()).runs).toBe(1);
      expect(runtime.runs[0]!.input.events.map((e) => e.id)).toEqual(ids);
      expect(h.runs().map((r) => r.end)).toEqual([{ kind: "sent", msgs: ["reply-1"] }]);
    });

    test("different threads run in different sessions, and a later event resumes its thread's session", async () => {
      h.append({ thread: "github:o/r#1" });
      h.append({ thread: "github:o/r#2" });
      const runtime = new ScriptedRuntime([{ sessionRef: "transcript-1" }]);
      const worker = h.worker({ runtime });

      expect((await worker.drain()).runs).toBe(2);
      const [one, two] = runtime.runs.map((r) => r.input.session);
      expect(one!.id).not.toBe(two!.id);
      expect([one!.resumed, two!.resumed]).toEqual([false, false]);

      const reply = h.append({ thread: "github:o/r#1" });
      expect(reply.resume).toBe(one!.id);
      expect((await worker.drain()).runs).toBe(1);
      expect(runtime.runs[2]!.input.session).toEqual({ id: one!.id, resumed: true, ref: "transcript-1", workdir: null });
    });
  });
}
