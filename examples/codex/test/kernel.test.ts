import { afterEach, expect, test } from "bun:test";
import { FakeClock } from "@aoa-dev/conformance";
import { createHost } from "@aoa-dev/sdk";
import { RETRY_NOTICE } from "@aoa-dev/sdk/prompt";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { codexRuntime } from "../src/index.ts";
import { FakeAppServer, type FakeTurn, type TurnScript } from "./fake-app-server.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** The Codex runtime as an SDK user hosts it, driven one pass at a time. */
function hosted(scripts: TurnScript[]) {
  const fake = new FakeAppServer(scripts);
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const agent = host.agent({
    name: "codex",
    inbox: "inbox",
    runtime: codexRuntime({ developerInstructions: "", cwd: "/repo", spawn: fake.spawn }),
    debounceMs: 0,
  });
  let n = 0;
  const say = () => agent.append({ source: "user_message", dedupeKey: `m${++n}`, payload: { text: `message ${n}` }, thread: "local:1", trusted: true });
  return { fake, host, agent, clock, say };
}

const toolCall = (t: FakeTurn, callId: string, tool: string, args: object) =>
  t.request("item/tool/call", { threadId: t.threadId, turnId: t.turnId, callId, namespace: null, tool, arguments: args });

test("a deferred command approval leaves one approval request and pauses the session", async () => {
  const { fake, host, agent, say } = hosted([
    async (t) =>
      void (await t.request("item/commandExecution/requestApproval", {
        threadId: t.threadId,
        turnId: t.turnId,
        itemId: "item-1",
        kind: "command",
        command: "rm -rf build",
        cwd: "/work",
      })),
  ]);
  say();
  await agent.step.worker();

  const [run] = agent.read.runs();
  const callId = `${run!.sessionId}:turn-1:item-1`;
  expect(run!.end).toEqual({ kind: "deferred", callId });
  expect(host.messages().filter((m) => m.kind === "approval_request")).toMatchObject([{ callId, body: expect.stringContaining("rm -rf build") }]);
  expect(fake.serverRequests[0]!.reply).toEqual({ decision: "decline" });
  expect(agent.read.sessions()[0]).toMatchObject({ status: "paused", pending: callId, runtimeRef: "thread-1" });
});

test("notify through a dynamic tool is decided, journaled and lands in the outbox; the result reaches Codex", async () => {
  const { fake, host, agent, say } = hosted([async (t) => void (await toolCall(t, "call-1", "notify", { body: "Branch aoa/1 is ready." }))]);
  say();
  await agent.step.worker();

  const [run] = agent.read.runs();
  const callId = `${run!.sessionId}:turn-1:call-1`;
  expect(agent.read.decisions(run!.sessionId).map((d) => [d.callId, d.tool, d.decision])).toEqual([[callId, "notify", "allow"]]);
  expect(agent.read.journal(run!.sessionId)).toMatchObject([{ callId, state: "done", result: { status: "ok" } }]);
  expect(host.messages()).toMatchObject([{ kind: "message", body: "Branch aoa/1 is ready." }]);
  expect(fake.serverRequests[0]!.reply.success).toBe(true);
  expect(run!.end).toMatchObject({ kind: "sent" });
});

test("ask_user through a dynamic tool interrupts the turn and the session waits for the answer", async () => {
  const { fake, host, agent, say } = hosted([async (t) => void (await toolCall(t, "call-1", "ask_user", { question: "Which colour?" }))]);
  say();
  await agent.step.worker();

  const [run] = agent.read.runs();
  expect(run!.end).toEqual({ kind: "deferred", callId: `${run!.sessionId}:turn-1:call-1` });
  expect(host.messages()).toMatchObject([{ kind: "approval_request", body: "Which colour?" }]);
  expect(fake.sent("turn/interrupt")).toHaveLength(1);
});

test("a run retried after a failed turn tells Codex the earlier attempt was interrupted; the first attempt does not", async () => {
  const { fake, agent, clock, say } = hosted([async () => ({ failed: "stream disconnected" }), async () => {}]);
  say();
  await agent.step.worker();
  // Past the retry delay after one failure.
  clock.advance(60 * 60_000);
  await agent.step.worker();

  expect(agent.read.runs().map((r) => r.error ?? r.end?.kind)).toEqual(["the Codex turn failed: stream disconnected", "silent"]);
  expect(fake.inputs[0]).not.toContain(RETRY_NOTICE);
  expect(fake.inputs[1]).toContain(RETRY_NOTICE);
});
