import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime, countingTool } from "@aoa-dev/conformance";
import type { Channel, OutMsg } from "@aoa-dev/kernel";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createHost } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const say = (text: string, thread = "t1", key = text) => ({
  source: "user_message" as const,
  dedupeKey: key,
  payload: { text },
  thread,
  trusted: true,
});

test("OutMsg.detail carries structured approval and dead-letter payloads to the channel and host.messages()", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock(1_000);
  const delivered: OutMsg[] = [];
  const channel: Channel = {
    deliver: async (m) => {
      delivered.push(m);
    },
  };
  const host = createHost({ store, clock, log: () => {} });

  const approver = host.agent({
    name: "ops",
    inbox: "ops",
    runtime: new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "c1", args: { env: "prod" } }] }]),
    tools: [countingTool("deploy")],
    channel,
    approvals: { ttlMs: 60_000 },
    debounceMs: 0,
  });
  approver.append(say("ship it", "t-ops"));
  await approver.step.worker();
  await approver.step.dispatcher();

  expect(delivered[0]?.detail).toEqual({
    kind: "approval",
    requestKind: "approval",
    callId: "c1",
    tool: "deploy",
    args: { env: "prod" },
    expiresAt: 61_000,
  });
  expect(host.messages()[0]?.detail).toEqual(delivered[0]!.detail);

  // Failing 3 times produces a dead-letter notice with structured detail.
  const failing = host.agent({
    name: "broken",
    inbox: "broken",
    runtime: new ScriptedRuntime([{ fail: new Error("boom 1") }, { fail: new Error("boom 2") }, { fail: new Error("boom 3") }]),
    channel,
    debounceMs: 0,
  });
  failing.append(say("try this", "t-broken"));
  for (let i = 0; i < 3; i++) {
    await failing.step.worker();
    clock.advance(5 * 60_000);
  }
  await failing.step.dispatcher();

  const deadMsg = delivered.find((m) => m.inboxId === "broken");
  expect(deadMsg?.detail).toMatchObject({
    kind: "dead_letter",
    error: "boom 3",
  });
  if (deadMsg?.detail?.kind === "dead_letter") {
    expect(deadMsg.detail.events).toHaveLength(1);
  }
});

test("reply: 'final_text' sends the assistant's final text without notify, stays silent when empty, omits QUIET, and tracks Already told the user", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const runtime = new ScriptedRuntime([
    { reply: "你好！已经帮你查好了。" },
    { reply: "   " },
    { calls: [{ tool: "notify", callId: "n1", args: { body: "explicit notice" } }], reply: "ignored duplicate" },
  ]);
  const agent = host.agent({
    name: "bot",
    inbox: "bot",
    runtime,
    reply: "final_text",
    debounceMs: 0,
  });

  agent.append(say("帮我查一下", "chat-1", "m1"));
  await agent.step.worker();

  // First run had no memory and no prior sent messages: no English QUIET boilerplate was injected.
  expect(runtime.runs[0]!.input.resident).toBe("");
  expect(host.messages().map((m) => m.body)).toEqual(["你好！已经帮你查好了。"]);
  expect(agent.read.runs()[0]!.end?.kind).toBe("sent");

  // Second run returns whitespace only -> stays silent (C18), while seeing the first reply under "Already told the user" (C19).
  agent.append(say("ping", "chat-1", "m2"));
  await agent.step.worker();
  expect(runtime.runs[1]!.input.resident).toContain("Already told the user");
  expect(runtime.runs[1]!.input.resident).toContain("你好！已经帮你查好了。");
  expect(runtime.runs[1]!.input.resident).not.toContain("Stay quiet unless");
  expect(agent.read.runs()[1]!.end).toEqual({ kind: "silent" });
  expect(host.messages()).toHaveLength(1);

  // Third run called notify explicitly -> final_text does not queue a second message.
  agent.append(say("status", "chat-1", "m3"));
  await agent.step.worker();
  expect(host.messages().map((m) => m.body)).toEqual(["你好！已经帮你查好了。", "explicit notice"]);
});

test("approvals: { by: 'answer', ttlMs }: chat messages during a pending approval queue instead of denying it, while ask_user still takes text replies", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const sendEmail = countingTool("send_email");
  const runtime = new ScriptedRuntime([
    { calls: [{ tool: "send_email", callId: "e1", args: { to: "bob@example.com" } }] },
    { calls: [{ tool: "ask_user", callId: "q1", args: { question: "Which subject line?" } }] },
    {},
  ]);
  const agent = host.agent({
    name: "assistant",
    inbox: "assistant",
    runtime,
    tools: [sendEmail],
    approvals: { by: "answer", ttlMs: 10_000 },
    debounceMs: 0,
  });

  agent.append(say("email Bob", "t1", "u1"));
  await agent.step.worker();
  expect(agent.read.pending()).toHaveLength(1);

  // User sends a follow-up chat message before clicking Approve: it must NOT deny the pending approval!
  agent.append(say("Also mention the release is Friday.", "t1", "u2"));
  await agent.step.worker();
  expect(agent.read.pending().map((p) => p.callId)).toEqual(["e1"]);
  expect(sendEmail.effects).toHaveLength(0);

  // Now the user clicks Approve: send_email executes once, AND the resumed run receives the queued chat message too.
  agent.answer("e1", { verdict: "approve", via: "button" });
  await agent.step.worker();
  expect(sendEmail.effects).toHaveLength(1);
  expect(runtime.runs[1]!.input.answer).toMatchObject({ callId: "e1", verdict: "approve" });
  expect(runtime.runs[1]!.input.events.some((e) => e.source === "user_message" && (e.payload as { text: string }).text.includes("Friday"))).toBe(true);

  // Run 2 called ask_user: a plain user_message on the thread still answers a question!
  expect(agent.read.pending().map((p) => [p.callId, p.kind])).toEqual([["q1", "question"]]);
  agent.append(say("Subject: Friday Release", "t1", "u3"));
  await agent.step.worker();
  expect(runtime.runs[2]!.input.answer).toMatchObject({
    callId: "q1",
    verdict: "approve",
    result: { status: "ok", output: "Subject: Friday Release" },
  });
});

test("approvals.ttlMs expires an unanswered approval after the configured duration", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const deploy = countingTool("deploy");
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "d1" }] }, {}]);
  const agent = host.agent({
    name: "ops",
    inbox: "ops",
    runtime,
    tools: [deploy],
    approvals: { by: "answer", ttlMs: 5_000 },
    debounceMs: 0,
  });

  agent.append(say("deploy", "t1"));
  await agent.step.worker();
  clock.advance(5_000);
  expect(agent.step.scheduler().fired).toBe(1);
  await agent.step.worker();

  expect(deploy.effects).toHaveLength(0);
  expect(runtime.runs[1]!.input.answer).toMatchObject({ callId: "d1", verdict: "deny" });
});
