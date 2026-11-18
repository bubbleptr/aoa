import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirMemory, memoryTools, outboxTools, type ToolDef } from "@aoa-dev/kernel";
import { FakeChannel, Harness, ScriptedRuntime, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C10 state outside the process survives a restart [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    const tools = (memoryRoot: string): ToolDef[] => [
      ...memoryTools(dirMemory(memoryRoot)),
      ...outboxTools({ store: h.store, clock: h.clock, inboxId: h.inboxId }),
    ];

    test("after everything is closed and reopened, the next run still has the instructions, its progress and what was reported", async () => {
      writeFileSync(join(h.memoryDir, "instructions.md"), "Always open PRs as drafts.");
      h.append({ thread: "github:o/r#12" });
      const runtime = new ScriptedRuntime([
        {
          calls: [
            {
              tool: "memory_write",
              callId: "call-1",
              args: (input) => ({ path: `progress/${input.session.id}.md`, content: "Done: reproduced the bug. Left: the fix." }),
            },
            { tool: "notify", callId: "call-2", args: { body: "Opened draft PR #13 for the crash." } },
          ],
        },
      ]);
      await h.worker({ runtime, tools: tools(h.memoryDir), memory: dirMemory(h.memoryDir) }).drain();
      await h.dispatcher({ channel: new FakeChannel() }).pass();

      h.restart();
      h.append({ thread: "github:o/r#12", payload: { text: "the build is red" } });
      const after = new ScriptedRuntime();
      await h.worker({ runtime: after, tools: tools(h.memoryDir), memory: dirMemory(h.memoryDir) }).drain();

      const { resident, session } = after.runs[0]!.input;
      expect(session.id).toBe(runtime.runs[0]!.input.session.id);
      expect(resident).toContain("Always open PRs as drafts.");
      expect(resident).toContain("Done: reproduced the bug. Left: the fix.");
      expect(resident).toContain("Opened draft PR #13 for the crash.");
    });
  });
}
