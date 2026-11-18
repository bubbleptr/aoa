import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@aoa-dev/conformance";
import type { LoopCompleteInput, LoopCompleteOutput } from "@aoa-dev/sdk/loop";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createDeskGateway, openaiComplete } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function scripted(steps: ((req: LoopCompleteInput) => LoopCompleteOutput)[]): {
  complete: (req: LoopCompleteInput) => Promise<LoopCompleteOutput>;
  inputs: LoopCompleteInput[];
} {
  const inputs: LoopCompleteInput[] = [];
  let i = 0;
  return {
    inputs,
    async complete(req) {
      inputs.push({ ...req, messages: [...req.messages] });
      const fn = steps[i++];
      return fn ? fn(req) : { text: "" };
    },
  };
}

test("conversational Chinese reply works without notify, injects no English QUIET prompt, and stays silent on empty output", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const deskModel = scripted([
    () => ({ text: "您好！请问需要查询哪笔订单？" }),
    () => ({ text: "" }),
  ]);
  const opsModel = scripted([]);
  const gw = createDeskGateway({
    store,
    clock,
    deskComplete: deskModel.complete,
    opsComplete: opsModel.complete,
  });

  gw.receive({ id: "m1", chatId: "u-100", text: "你好" });
  await gw.drain();

  const firstUserTurn = deskModel.inputs[0]!.messages[0]!;
  expect(firstUserTurn.role === "user" && firstUserTurn.content).not.toContain("Stay quiet");
  expect(gw.out).toEqual([{ type: "text", agent: "desk", thread: "chat:u-100", text: "您好！请问需要查询哪笔订单？" }]);

  // Empty model output produces no message (C18), while seeing prior reply in Already told the user (C19).
  gw.receive({ id: "m2", chatId: "u-100", text: "收到" });
  await gw.drain();
  const secondUserTurn = deskModel.inputs[1]!.messages.at(-1)!;
  expect(secondUserTurn.role === "user" && secondUserTurn.content).toContain("Already told the user");
  expect(gw.out).toHaveLength(1);
});

test("button approval card: a follow-up message sent before clicking Approve queues alongside the approval instead of denying it", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock(10_000);
  const deskModel = scripted([]);
  const opsModel = scripted([
    () => ({ toolCalls: [{ id: "tc_1", name: "issue_refund", args: { orderId: "ORD-9", cents: 2500 } }] }),
    () => ({ text: "已为订单 ORD-9 退款 25.00 元，并记录备注：重复扣款。" }),
  ]);
  const gw = createDeskGateway({
    store,
    clock,
    deskComplete: deskModel.complete,
    opsComplete: opsModel.complete,
  });

  gw.receive({ id: "m1", chatId: "vip-1", text: "@ops 给 ORD-9 退款 25 元" });
  await gw.drain();

  expect(gw.refunds).toEqual([]);
  expect(gw.out).toHaveLength(1);
  const card = gw.out[0]!;
  expect(card).toEqual({
    type: "approval_card",
    agent: "ops",
    thread: "chat:vip-1",
    callId: expect.stringContaining(":tc_1"),
    requestKind: "approval",
    tool: "issue_refund",
    args: { orderId: "ORD-9", cents: 2500 },
    expiresAt: 10_000 + 72 * 3_600_000,
    buttons: ["approve", "deny"],
  });

  // User sends a follow-up note BEFORE clicking the Approve button: must NOT deny the pending refund!
  gw.receive({ id: "m2", chatId: "vip-1", text: "@ops 顺便备注原因：重复扣款" });
  await gw.drain();
  expect(gw.ops.read.pending()).toHaveLength(1);
  expect(gw.refunds).toEqual([]);

  // Now the operator clicks Approve on the card: refund executes once, AND the resumed run sees the follow-up note.
  if (card.type !== "approval_card") throw new Error("expected card");
  gw.click(card.callId, "approve");
  await gw.drain();

  expect(gw.refunds).toEqual([{ orderId: "ORD-9", cents: 2500 }]);
  const resumedPrompt = opsModel.inputs[1]!.messages.findLast((m) => m.role === "user");
  expect(resumedPrompt?.role === "user" && resumedPrompt.content).toContain("重复扣款");
  expect(gw.out.at(-1)).toEqual({
    type: "text",
    agent: "ops",
    thread: "chat:vip-1",
    text: "已为订单 ORD-9 退款 25.00 元，并记录备注：重复扣款。",
  });
});

test("multi-agent collaboration: desk hands off to ops via send_to, ops pauses for card approval, then replies back to desk", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const deskModel = scripted([
    // Run 1: call send_to, then end turn silently while waiting for ops's reply.
    () => ({ toolCalls: [{ id: "s1", name: "send_to", args: { agent: "ops", text: "请查询并退掉订单 ORD-7" } }] }),
    () => ({ text: "" }),
    // Run 2 (resumed by ops's reply): answer the user on chat:room-42.
    () => ({ text: "客服前台：后台已完成订单 ORD-7 的 12.00 元退款。" }),
  ]);
  const opsModel = scripted([
    // Run 1: lookup order, then request high-risk refund (pauses on approval card).
    () => ({ toolCalls: [{ id: "l1", name: "lookup_order", args: { orderId: "ORD-7" } }] }),
    () => ({ toolCalls: [{ id: "r1", name: "issue_refund", args: { orderId: "ORD-7", cents: 1200 } }] }),
    // Run 2 (resumed after card approval): send result back to desk, then finish internal sub-session.
    () => ({ toolCalls: [{ id: "s2", name: "send_to", args: { agent: "desk", text: "ORD-7 已退 1200 分" } }] }),
    () => ({ text: "已回报前台" }),
  ]);
  const gw = createDeskGateway({
    store,
    clock,
    orders: { "ORD-7": { cents: 1200, status: "paid" } },
    deskComplete: deskModel.complete,
    opsComplete: opsModel.complete,
  });

  gw.receive({ id: "c1", chatId: "room-42", text: "帮我退一下订单 ORD-7" });
  await gw.drain();

  // Desk stayed quiet while waiting on ops; ops looked up ORD-7 and emitted an approval card for issue_refund.
  expect(gw.out).toHaveLength(1);
  expect(gw.out[0]?.type).toBe("approval_card");
  if (gw.out[0]?.type !== "approval_card") throw new Error("expected card");

  gw.click(gw.out[0].callId, "approve");
  await gw.drain();

  expect(gw.refunds).toEqual([{ orderId: "ORD-7", cents: 1200 }]);
  // Ops's internal `agent:ops/...` final text was not leaked to the user chat; only desk's reply on chat:room-42 went out.
  expect(gw.out).toHaveLength(2);
  expect(gw.out[1]).toEqual({
    type: "text",
    agent: "desk",
    thread: "chat:room-42",
    text: "客服前台：后台已完成订单 ORD-7 的 12.00 元退款。",
  });
});

test("openaiComplete speaks Chat Completions over plain fetch and example-assistant has no pi dependency", async () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["@aoa-dev/sdk", "@aoa-dev/store-sqlite"]);

  let capturedBody: unknown = null;
  const complete = openaiComplete({
    baseUrl: "https://example.test/v1/",
    apiKey: "sk-test",
    model: "deepseek-chat",
    fetch: (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                reasoning_content: "need order status",
                tool_calls: [{ id: "call_9", function: { name: "lookup_order", arguments: '{"orderId":"ORD-1"}' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });

  const out = await complete({
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "lookup_order", description: "lookup", schema: { type: "object" } }],
    signal: new AbortController().signal,
    emit: () => {},
  });
  expect(capturedBody).toMatchObject({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  });
  expect(out).toEqual({
    reasoning: "need order status",
    toolCalls: [{ id: "call_9", name: "lookup_order", args: { orderId: "ORD-1" } }],
  });
});
