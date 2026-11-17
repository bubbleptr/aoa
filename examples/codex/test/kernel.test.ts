import { afterEach, beforeEach, expect, test } from "bun:test";
import { askUserTools, outboxTools } from "@aoa/kernel";
import { RETRY_NOTICE } from "@aoa/sdk/prompt";
import { Harness, sqliteFactory } from "@aoa/conformance";
import { codexRuntime } from "../src/index.ts";
import { FakeAppServer, type FakeTurn, type TurnScript } from "./fake-app-server.ts";

let h: Harness;
beforeEach(() => {
  h = new Harness(sqliteFactory());
});
afterEach(() => h.dispose());

function worker(scripts: TurnScript[]) {
  const fake = new FakeAppServer(scripts);
  const deps = { store: h.store, clock: h.clock, inboxId: h.inboxId };
  const w = h.worker({
    runtime: codexRuntime({ developerInstructions: "", cwd: "/repo", spawn: fake.spawn }),
    tools: [...outboxTools(deps), ...askUserTools()],
  });
  return { fake, w };
}

const toolCall = (t: FakeTurn, callId: string, tool: string, args: object) =>
  t.request("item/tool/call", { threadId: t.threadId, turnId: t.turnId, callId, namespace: null, tool, arguments: args });

test("a deferred command approval leaves one approval request in the outbox and pauses the session", async () => {
  const { fake, w } = worker([
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
  h.append({ thread: "local:1" });
  await w.drain();

  const [run] = h.runs();
  const callId = `${run!.sessionId}:turn-1:item-1`;
  expect(run!.end).toEqual({ kind: "deferred", callId });
  expect(h.outbox().filter((m) => m.kind === "approval_request")).toMatchObject([{ callId, body: expect.stringContaining("rm -rf build") }]);
  expect(fake.serverRequests[0]!.reply).toEqual({ decision: "decline" });
  expect(h.store.tx((t) => t.getSession(run!.sessionId))).toMatchObject({ status: "paused", pending: callId, runtimeRef: "thread-1" });
});

test("notify through a dynamic tool is decided, journaled and lands in the outbox; the result reaches Codex", async () => {
  const { fake, w } = worker([async (t) => void (await toolCall(t, "call-1", "notify", { body: "Branch aoa/1 is ready." }))]);
  h.append({ thread: "local:1" });
  await w.drain();

  const [run] = h.runs();
  const callId = `${run!.sessionId}:turn-1:call-1`;
  expect(h.store.tx((t) => t.listDecisions(run!.sessionId)).map((d) => [d.callId, d.tool, d.decision])).toEqual([[callId, "notify", "allow"]]);
  expect(h.store.tx((t) => t.getJournal(run!.sessionId, callId))).toMatchObject({ state: "done", result: { status: "ok" } });
  expect(h.outbox()).toMatchObject([{ kind: "message", body: "Branch aoa/1 is ready." }]);
  expect(fake.serverRequests[0]!.reply.success).toBe(true);
  expect(run!.end).toMatchObject({ kind: "sent" });
});

test("ask_user through a dynamic tool interrupts the turn and the session waits for the answer", async () => {
  const { fake, w } = worker([async (t) => void (await toolCall(t, "call-1", "ask_user", { question: "Which colour?" }))]);
  h.append({ thread: "local:1" });
  await w.drain();

  const [run] = h.runs();
  expect(run!.end).toEqual({ kind: "deferred", callId: `${run!.sessionId}:turn-1:call-1` });
  expect(h.outbox()).toMatchObject([{ kind: "approval_request", body: "Which colour?" }]);
  expect(fake.sent("turn/interrupt")).toHaveLength(1);
});

test("a run retried after a failed turn tells Codex the earlier attempt was interrupted; the first attempt does not", async () => {
  const { fake, w } = worker([async () => ({ failed: "stream disconnected" }), async () => {}]);
  h.append({ thread: "local:1" });
  await w.drain();
  h.waitOutLease();
  await w.drain();

  expect(h.runs().map((r) => r.error ?? r.end?.kind)).toEqual(["the Codex turn failed: stream disconnected", "silent"]);
  expect(fake.inputs[0]).not.toContain(RETRY_NOTICE);
  expect(fake.inputs[1]).toContain(RETRY_NOTICE);
});
