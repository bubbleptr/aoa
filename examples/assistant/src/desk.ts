import {
  createHost,
  sendToTool,
  type Agent,
  type Channel,
  type Clock,
  type Host,
  type HostStore,
  type OutMsg,
  type ToolDef,
} from "@aoa-dev/sdk";
import { loopRuntime, type LoopComplete, type TranscriptStore } from "@aoa-dev/sdk/loop";

/** Structured outbound items a chat gateway (Slack, Feishu, Telegram, Web) renders without parsing Markdown. */
export type GatewayOut =
  | {
      type: "text";
      agent: string;
      thread: string | null;
      text: string;
    }
  | {
      type: "approval_card";
      agent: string;
      thread: string | null;
      callId: string;
      requestKind: "approval" | "question" | "harness" | "admit";
      tool: string;
      args: unknown;
      expiresAt: number;
      buttons: readonly ["approve", "deny"];
    }
  | {
      type: "dead_alert";
      agent: string;
      thread: string | null;
      events: string[];
      error: string | null;
    };

export type RefundRecord = { orderId: string; cents: number };

export type DeskOptions = {
  store: HostStore;
  clock?: Clock;
  transcripts?: TranscriptStore;
  deskComplete: LoopComplete;
  opsComplete: LoopComplete;
  orders?: Record<string, { cents: number; status: string }>;
};

export type DeskGateway = {
  readonly host: Host;
  readonly desk: Agent;
  readonly ops: Agent;
  readonly out: GatewayOut[];
  readonly refunds: RefundRecord[];
  /** Routes an incoming chat message from one shared webhook into the right agent's inbox. */
  receive(msg: { id: string; chatId: string; text: string; to?: "desk" | "ops" }): void;
  /** Handles an interactive button click from an approval card. */
  click(callId: string, verdict: "approve" | "deny", note?: string): void;
  /** Runs one deterministic pass of both agents and their dispatchers (for tests or serverless ticks). */
  drain(): Promise<void>;
};

export const DESK_PROMPT =
  "你是中文客服前台（desk）。用户咨询订单时直接用中文简明回复；需要查单或退款时调用 send_to 交给 ops 处理，收到 ops 回信后再答复用户。";

export const OPS_PROMPT =
  "你是后台操作员（ops）。你可以调用 lookup_order 查询订单，或调用 issue_refund 发起退款（高风险操作需人工点击卡片批准）。处理完前台转交的请求后，调用 send_to 回复 desk；若是用户直接找你，直接中文回复即可。";

export function createDeskGateway(o: DeskOptions): DeskGateway {
  const host = createHost({ store: o.store, ...(o.clock ? { clock: o.clock } : {}), log: () => {} });
  const out: GatewayOut[] = [];
  const refunds: RefundRecord[] = [];
  const orders = o.orders ?? {};

  const channelFor = (agentName: string): Channel => ({
    async deliver(m: OutMsg) {
      if (m.detail?.kind === "approval") {
        out.push({
          type: "approval_card",
          agent: agentName,
          thread: m.thread,
          callId: m.detail.callId,
          requestKind: m.detail.requestKind,
          tool: m.detail.tool,
          args: m.detail.args,
          expiresAt: m.detail.expiresAt,
          buttons: ["approve", "deny"],
        });
        return;
      }
      if (m.detail?.kind === "dead_letter") {
        out.push({
          type: "dead_alert",
          agent: agentName,
          thread: m.thread,
          events: m.detail.events,
          error: m.detail.error,
        });
        return;
      }
      // Internal agent-to-agent sub-threads (`agent:...`) carry handoffs; only user chat threads go to the user's window,
      // while approval cards and dead-letter alerts from any agent always reach the operator console.
      if (m.thread?.startsWith("agent:")) return;
      out.push({ type: "text", agent: agentName, thread: m.thread, text: m.body });
    },
  });

  const lookupOrder: ToolDef = {
    name: "lookup_order",
    risk: "low",
    description: "Look up an order by id.",
    schema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    idempotent: true,
    async execute(raw) {
      const { orderId } = raw as { orderId: string };
      return orders[orderId] ?? { status: "not_found" };
    },
  };

  const issueRefund: ToolDef = {
    name: "issue_refund",
    risk: "high",
    description: "Refund an order in cents.",
    schema: {
      type: "object",
      properties: { orderId: { type: "string" }, cents: { type: "integer", minimum: 1 } },
      required: ["orderId", "cents"],
      additionalProperties: false,
    },
    async execute(raw) {
      const { orderId, cents } = raw as RefundRecord;
      refunds.push({ orderId, cents });
      return { refunded: true, orderId, cents };
    },
  };

  const sendTo = sendToTool(host);

  const desk = host.agent({
    name: "desk",
    description: "中文客服前台，接待用户咨询",
    inbox: "desk",
    runtime: loopRuntime({
      systemPrompt: DESK_PROMPT,
      complete: o.deskComplete,
      ...(o.transcripts ? { transcripts: o.transcripts } : {}),
    }),
    tools: (builtins) => [sendTo, ...builtins.filter((t) => t.name === "ask_user")],
    channel: channelFor("desk"),
    reply: "final_text",
    approvals: { by: "answer", ttlMs: 72 * 3_600_000 },
    debounceMs: 0,
  });

  const ops = host.agent({
    name: "ops",
    description: "后台操作员，查单与执行退款",
    inbox: "ops",
    runtime: loopRuntime({
      systemPrompt: OPS_PROMPT,
      complete: o.opsComplete,
      ...(o.transcripts ? { transcripts: o.transcripts } : {}),
    }),
    tools: (builtins) => [lookupOrder, issueOrderTool(issueRefund), sendTo, ...builtins.filter((t) => t.name === "ask_user")],
    channel: channelFor("ops"),
    reply: "final_text",
    approvals: { by: "answer", ttlMs: 72 * 3_600_000 },
    debounceMs: 0,
  });

  return {
    host,
    desk,
    ops,
    out,
    refunds,
    receive(msg) {
      const target = msg.to === "ops" || msg.text.startsWith("@ops ") ? ops : desk;
      const text = msg.text.replace(/^@ops\s+/, "");
      target.append({
        source: "user_message",
        dedupeKey: `chat:${msg.id}`,
        payload: { text },
        thread: `chat:${msg.chatId}`,
        trusted: true,
      });
    },
    click(callId, verdict, note) {
      const pending = host.snapshot(() => [desk, ops].flatMap((a) => a.read.pending()).find((p) => p.callId === callId));
      if (!pending) throw new Error(`No approval card ${callId} is waiting.`);
      const owner = pending.inboxId === ops.inbox ? ops : desk;
      owner.answer(callId, { verdict, ...(note === undefined ? {} : { text: note }), via: "card" });
    },
    async drain() {
      // Drain until neither agent has pending work left from cross-agent `send_to` handoffs.
      for (let i = 0; i < 8; i++) {
        const d = await desk.step.worker();
        const p = await ops.step.worker();
        await desk.step.dispatcher();
        await ops.step.dispatcher();
        if (d.runs === 0 && p.runs === 0) break;
      }
    },
  };
}

const issueOrderTool = (t: ToolDef): ToolDef => t;
