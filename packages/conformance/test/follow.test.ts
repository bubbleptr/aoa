import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { followTools } from "@aoa/kernel";
import { Harness, ScriptedRuntime, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`follow [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    const tools = () => followTools({ store: h.store, inboxId: h.inboxId });

    test("a followed thread brings its later events back to the session that followed it", async () => {
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "follow", callId: "call-1", args: { thread: "pr-7" } }] }]);
      const worker = h.worker({ runtime, tools: tools() });
      h.append({ thread: "issue-1" });
      await worker.drain();

      h.append({ thread: "pr-7", payload: { text: "please rename it" } });
      await worker.drain();

      const session = runtime.runs[0]!.input.session.id;
      expect(runtime.runs[0]!.toolResults).toEqual([{ status: "ok", output: { thread: "pr-7", following: true } }]);
      expect(runtime.runs[1]!.input.session).toMatchObject({ id: session, resumed: true });
    });

    test("a thread that belongs to another session is refused and stays with it", async () => {
      const runtime = new ScriptedRuntime([{}, { calls: [{ tool: "follow", callId: "call-1", args: { thread: "issue-1" } }] }]);
      const worker = h.worker({ runtime, tools: tools() });
      h.append({ thread: "issue-1" });
      await worker.drain();
      h.append({ thread: "issue-2" });
      await worker.drain();

      expect(runtime.runs[1]!.toolResults[0]).toMatchObject({ status: "error" });
      h.append({ thread: "issue-1" });
      await worker.drain();
      expect(runtime.runs[2]!.input.session.id).toBe(runtime.runs[0]!.input.session.id);
    });

    test("following a thread the session already has succeeds and changes nothing", async () => {
      const runtime = new ScriptedRuntime([
        {
          calls: [
            { tool: "follow", callId: "call-1", args: { thread: "issue-1" } },
            { tool: "follow", callId: "call-2", args: { thread: "pr-7" } },
            { tool: "follow", callId: "call-3", args: { thread: "pr-7" } },
          ],
        },
      ]);
      h.append({ thread: "issue-1" });
      await h.worker({ runtime, tools: tools() }).drain();

      const session = runtime.runs[0]!.input.session.id;
      expect(runtime.runs[0]!.toolResults.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
      expect(h.store.tx((t) => t.primaryThread(session))).toBe("issue-1");
    });
  });
}
