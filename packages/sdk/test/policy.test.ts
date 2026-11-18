import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime } from "@aoa-dev/conformance";
import { appendEvent, type ToolDef } from "../src/kernel/index.ts";
import { sqliteStore } from "../src/index.ts";
import { createHost } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

test("an agent without a policy is safe by default: an unknown tool waits for the user, notify does not", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  let deployed = 0;
  const deploy: ToolDef = {
    name: "deploy",
    description: "Deploys.",
    schema: { type: "object" },
    async execute() {
      deployed++;
      return "deployed";
    },
  };
  const runtime = new ScriptedRuntime([
    { calls: [{ tool: "notify", callId: "c1", args: { body: "Starting." } }, { tool: "deploy", callId: "c2" }] },
  ]);
  const agent = createHost({ store, clock, log: () => {} }).agent({ name: "a", inbox: "in", runtime, tools: [deploy], debounceMs: 0 });
  appendEvent({ store, clock, inboxId: "in" }, { source: "user_message", dedupeKey: "m1", payload: { text: "go" }, thread: "t", trusted: true });

  await agent.step.worker();

  expect(runtime.runs[0]!.toolResults.map((r) => r.status)).toEqual(["ok", "deferred"]);
  expect(deployed).toBe(0);
  expect(store.tx((t) => t.listDeferred("in")).map((d) => d.tool)).toEqual(["deploy"]);
});
