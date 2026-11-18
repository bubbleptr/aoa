import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { FakeClock } from "@aoa-dev/conformance";
import type { RunActivity } from "../../src/kernel/index.ts";
import { sqliteStore } from "../../src/index.ts";
import { createHost } from "../../src/index.ts";
import { scriptedRuntime } from "./harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test("a pi run streams its text, then tool_start and tool_end for its call, to the agent's subscribers", async () => {
  const h = scriptedRuntime();
  cleanups.push(h.cleanup);
  const store = sqliteStore(":memory:");
  cleanups.push(() => store.close());
  const host = createHost({ store, clock: new FakeClock(), log: () => {} });
  const agent = host.agent({
    name: "a",
    inbox: "in",
    runtime: h.runtime,
    tools: [{ name: "lookup", description: "Looks up.", schema: { type: "object" }, risk: "low", execute: async () => "apples" }],
    debounceMs: 0,
  });
  const seen: RunActivity[] = [];
  const runs = new Set<string>();
  agent.activity((a, run) => {
    seen.push(a);
    runs.add(run.runId);
  });
  h.script([
    fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("lookup", { value: "x" }, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);

  agent.append({ source: "user_message", dedupeKey: "m1", payload: { text: "find it" }, thread: "t", trusted: true });
  await agent.step.worker();

  const text = (from: number, to: number) =>
    seen
      .slice(from, to)
      .map((a) => (a.kind === "text" ? a.delta : ""))
      .join("");
  const start = seen.findIndex((a) => a.kind === "tool_start");
  const end = seen.findIndex((a) => a.kind === "tool_end");
  expect(text(0, start)).toBe("Let me look.");
  expect(seen[start]).toMatchObject({ kind: "tool_start", tool: "lookup", args: { value: "x" } });
  expect(end).toBe(start + 1);
  expect(seen[end]).toMatchObject({ kind: "tool_end", result: { status: "ok", output: "apples" } });
  expect(text(end + 1, seen.length)).toBe("Done.");
  expect(seen.filter((a) => a.kind !== "text")).toHaveLength(2);
  expect(runs.size).toBe(1);
});
