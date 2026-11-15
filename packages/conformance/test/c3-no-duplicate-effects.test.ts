import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEASE_MS, SimulatedCrash, type ToolDef } from "@aoa/kernel";
import { Harness, ScriptedRuntime, crashAt, storeFactories, type RunScript } from "../src/index.ts";

/** A tool whose external effect the test can count. */
function externalWrite(idempotent = false): ToolDef & { effects: unknown[] } {
  const effects: unknown[] = [];
  return {
    name: "open_issue",
    description: "Opens an issue in an external tracker",
    schema: { type: "object" },
    idempotent,
    effects,
    async execute(args) {
      effects.push(args);
      return { issue: effects.length };
    },
  };
}

const openIssue: RunScript = { calls: [{ tool: "open_issue", callId: "call-1", args: { title: "bug" } }] };

for (const [name, factory] of storeFactories) {
  describe(`C3 a rerun does not repeat side effects [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    async function crashThenRerun(point: "before_complete" | "after_tool_exec", tool: ToolDef) {
      const { id } = h.append();
      const runtime = new ScriptedRuntime([openIssue, openIssue]);
      await expect(h.worker({ runtime, tools: [tool], crash: crashAt(point) }).drain()).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      h.clock.advance(LEASE_MS);
      expect((await h.worker({ runtime, tools: [tool], store: h.connect() }).drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("done");
      const [first, rerun] = runtime.runs;
      expect(rerun!.input.session).toMatchObject({ id: first!.input.session.id, resumed: true });
      return { first: first!, rerun: rerun! };
    }

    test("crash before completing: the rerun gets the recorded result without executing", async () => {
      const tool = externalWrite();
      const { first, rerun } = await crashThenRerun("before_complete", tool);
      expect(tool.effects).toHaveLength(1);
      expect(rerun.toolResults).toEqual([{ status: "ok", output: { issue: 1 } }]);
      expect(rerun.toolResults).toEqual(first.toolResults);
    });

    test("crash after executing, before recording: the rerun is told the outcome is unknown", async () => {
      const tool = externalWrite();
      const { rerun } = await crashThenRerun("after_tool_exec", tool);
      expect(tool.effects).toHaveLength(1);
      expect(rerun.toolResults).toEqual([{ status: "unknown", message: expect.any(String) }]);
    });

    test("an idempotent tool is executed again when its outcome is unknown", async () => {
      const tool = externalWrite(true);
      const { rerun } = await crashThenRerun("after_tool_exec", tool);
      expect(tool.effects).toHaveLength(2);
      expect(rerun.toolResults).toEqual([{ status: "ok", output: { issue: 2 } }]);
    });
  });
}
