import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunActivity } from "@aoa/kernel";
import { Harness, ScriptedRuntime, countingTool, storeFactories } from "../src/index.ts";

/** The activity stream (design §15「活动流」): what the kernel emits for `input.tools`, and what it leaves out. */
for (const [name, factory] of storeFactories) {
  describe(`activity stream [${name}]`, () => {
    let h: Harness;
    let seen: { run: string; a: RunActivity }[];
    beforeEach(() => {
      h = new Harness(factory());
      seen = [];
    });
    afterEach(() => h.dispose());

    const lookup = () => ({ ...countingTool("lookup", true), risk: "low" as const });
    const deploy = () => ({ ...countingTool("deploy"), risk: "high" as const });
    const drain = (runtime: ScriptedRuntime, tools = [lookup(), deploy()], extra = {}) =>
      h.worker({ runtime, tools, debounceMs: 0, onActivity: (a, run) => seen.push({ run: run.runId, a }), ...extra }).drain();
    const kinds = () => seen.map((s) => s.a.kind);

    test("the runtime's text, then tool_start and tool_end around an executed call, in order", async () => {
      h.append({ thread: "t" });
      await drain(new ScriptedRuntime([{ text: "looking", calls: [{ tool: "lookup", callId: "c1", args: { q: 1 } }] }]));
      expect(seen.map((s) => s.a)).toEqual([
        { kind: "text", delta: "looking" },
        { kind: "tool_start", callId: "c1", tool: "lookup", args: { q: 1 } },
        { kind: "tool_end", callId: "c1", result: { status: "ok", output: { done: 1 } } },
      ]);
      expect(seen[0]!.run).toBe(h.runs()[0]!.id);
    });

    test("a deferred call and a blocked call emit nothing", async () => {
      h.append({ thread: "t" });
      const block = { name: "no-lookup", match: (c: { tool: string }) => (c.tool === "lookup" ? ("block" as const) : null) };
      await drain(
        new ScriptedRuntime([{ calls: [{ tool: "lookup", callId: "c1" }, { tool: "deploy", callId: "c2" }] }]),
        [lookup(), deploy()],
        { policy: { rules: [block] } },
      );
      expect(kinds()).toEqual([]);
    });

    test("a call replayed from the journal on a retry emits nothing", async () => {
      h.append({ thread: "t" });
      const runtime = new ScriptedRuntime([
        { calls: [{ tool: "lookup", callId: "c1" }], fail: new Error("model went away") },
        { calls: [{ tool: "lookup", callId: "c1" }] },
      ]);
      await drain(runtime);
      h.clock.advance(60 * 60_000);
      await drain(runtime);
      expect(runtime.runs).toHaveLength(2);
      expect(seen.filter((s) => s.run === h.runs()[1]!.id)).toEqual([]);
    });

    test("an approved call is executed, and emitted, in the run that takes the answer", async () => {
      h.append({ thread: "t" });
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "c1" }] }]);
      await drain(runtime);
      expect(kinds()).toEqual([]);
      h.append({ thread: "t", payload: { text: "/approve" } });
      await drain(runtime);
      expect(seen.map((s) => [s.run, s.a.kind])).toEqual([
        [h.runs()[1]!.id, "tool_start"],
        [h.runs()[1]!.id, "tool_end"],
      ]);
    });

    test("a subscriber that throws changes neither the run's end nor the journal", async () => {
      h.append({ thread: "t" });
      const tool = lookup();
      await h
        .worker({
          runtime: new ScriptedRuntime([{ text: "hi", calls: [{ tool: "lookup", callId: "c1" }] }]),
          tools: [tool],
          debounceMs: 0,
          onActivity: () => {
            throw new Error("the page went away");
          },
        })
        .drain();
      expect(h.runs()[0]!.error).toBeNull();
      expect(tool.effects).toHaveLength(1);
      const [session] = h.store.tx((t) => t.listSessions(h.inboxId));
      expect(h.store.tx((t) => t.getJournal(session!.id, "c1"))?.result).toEqual({ status: "ok", output: { done: 1 } });
    });
  });
}
