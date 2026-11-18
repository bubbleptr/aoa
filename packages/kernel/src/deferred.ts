import type { Tx } from "./ports.ts";
import type { CallId, InboxId, NewEvent, PendingCall, SessionId, ToolDef } from "./types.ts";

/** How long a deferred call waits for an answer before it is denied (D-PRM-2). */
export const DEFER_TTL_MS = 24 * 60 * 60_000;

export const EXPIRY_TEXT = "No answer within 24 hours.";

/**
 * The payload of an `approval_answer` event. `via` names where an answer given outside the thread came from (e.g.
 * `mcp`); absent for a reply on the thread, the expiry and `aoa answer`.
 */
export type AnswerPayload = { callId: CallId; verdict: "approve" | "deny"; text?: string; expired?: true; via?: string };

const questionTools = new WeakSet<ToolDef>();

/** `ask_user` cannot be told apart by its shape, so the kernel remembers the definitions it made. */
export const isQuestionTool = (def: ToolDef): boolean => questionTools.has(def);

/** `ask_user`: always deferred as a question; the user's reply becomes the call's result. */
export function askUserTools(): ToolDef[] {
  const askUser: ToolDef = {
    name: "ask_user",
    description:
      "Ask the user a question and stop until they answer. Use it only when you cannot go on without " +
      "their decision or knowledge. Their reply comes back as this call's result in a later run.",
    schema: {
      type: "object",
      properties: { question: { type: "string", description: "The question, self-contained: the user may read it hours later." } },
      required: ["question"],
      additionalProperties: false,
    },
    async execute() {
      throw new Error("ask_user is answered by the user, never executed");
    },
  };
  questionTools.add(askUser);
  return [askUser];
}

export const expiryTimerId = (callId: CallId): string => `expire:${callId}`;

export const answerEvent = (answer: AnswerPayload, thread: string | null): NewEvent => ({
  source: "approval_answer",
  dedupeKey: `answer:${answer.callId}`,
  payload: answer,
  ...(thread === null ? {} : { thread }),
  trusted: true,
});

/**
 * The whole deferral in the caller's transaction (spec §6.4): the pending call, the paused session,
 * exactly one request in the outbox (I-OUT-5) and the timer that expires it.
 */
export function deferInTx(t: Tx, d: PendingCall, reason?: string): void {
  t.insertDeferred(d);
  t.setSessionPending(d.sessionId, d.callId);
  t.insertOutMsg({
    id: crypto.randomUUID(),
    inboxId: d.inboxId,
    sessionId: d.sessionId,
    thread: t.primaryThread(d.sessionId),
    kind: "approval_request",
    body: requestBody(d, reason),
    callId: d.callId,
    detail: {
      kind: "approval",
      requestKind: d.kind,
      callId: d.callId,
      tool: d.tool,
      args: d.args,
      ...(reason === undefined ? {} : { reason }),
      expiresAt: d.expiresAt,
    },
    dedupeKey: `approval:${d.callId}`,
    createdAt: d.requestedAt,
  });
  const ttlMs = d.expiresAt - d.requestedAt;
  t.insertTimer({
    id: expiryTimerId(d.callId),
    inboxId: d.inboxId,
    kind: "follow_up",
    sessionId: d.sessionId,
    due: d.expiresAt,
    recurrence: null,
    payload: ttlMs === DEFER_TTL_MS ? { expiredCall: d.callId } : { expiredCall: d.callId, ttlMs },
  });
}

function requestBody(d: PendingCall, reason: string | undefined): string {
  if (d.kind === "question") return (d.args as { question: string }).question;
  if (d.kind === "admit") {
    const { from, preview } = d.args as { from: string; preview: string };
    return [
      `Input from ${from} is waiting for the agent. It is not from you, so the agent does not see it unless you let it in:`,
      "",
      `> ${preview}`,
      "",
      "Reply `/approve` to let the agent read it, or `/deny` to drop it.",
    ].join("\n");
  }
  return [
    `The agent wants to call \`${d.tool}\` and needs your approval:`,
    "",
    "```json",
    JSON.stringify(d.args, null, 2),
    "```",
    "",
    ...(reason ? [`Its reason: ${reason}`, ""] : []),
    "Reply `/approve` to let it run, or `/deny <reason>` to refuse.",
  ].join("\n");
}

export type ApprovalReplyMode = "reply" | "answer";

/**
 * Recognises an answer on its way into the inbox (design §6, "怎么回答"): the user's next message on the
 * thread of a paused session, or the expiry of the pending call. Everything else passes through unchanged.
 * Only trusted events can answer (I-PRM-2). With `approvalBy = "answer"`, approvals (`approval` / `harness` / `admit`)
 * are settled only through `answer()`, while free-text replies still answer `ask_user` questions and queue alongside
 * pending approvals without denying them.
 */
export function asAnswer(
  t: Tx,
  inboxId: InboxId,
  e: NewEvent,
  resume: SessionId | undefined,
  approvalBy: ApprovalReplyMode = "reply",
): { event: NewEvent; resume: SessionId } | null {
  const thread = e.thread ?? null;
  if (e.source === "timer") {
    const payload = e.payload as { expiredCall?: unknown; ttlMs?: unknown } | null;
    const callId = payload?.expiredCall;
    if (typeof callId !== "string" || resume === undefined) return null;
    const text = typeof payload?.ttlMs === "number" ? `No answer within ${Math.round(payload.ttlMs / 1000)}s.` : EXPIRY_TEXT;
    return { event: answerEvent({ callId, verdict: "deny", text, expired: true }, thread), resume };
  }
  if (e.source !== "user_message" || !e.trusted || thread === null) return null;
  const sessionId = resume ?? t.sessionForThread(inboxId, thread);
  const session = sessionId === null ? null : t.getSession(sessionId);
  if (!session || session.status !== "paused" || session.pending === null) return null;
  const pending = t.getDeferred(session.pending);
  const text = (e.payload as { text?: unknown } | null)?.text;
  if (!pending || typeof text !== "string") return null;
  if (approvalBy === "answer" && pending.kind !== "question") return null;
  const reply = parseReply(text, pending.kind);
  return reply && { event: answerEvent({ callId: pending.callId, ...reply }, thread), resume: session.id };
}

function parseReply(text: string, kind: PendingCall["kind"]): Omit<AnswerPayload, "callId"> | null {
  const trimmed = text.trim();
  const command = /^\/(approve|deny)\b\s*([\s\S]*)$/i.exec(trimmed);
  if (command) {
    const rest = command[2]!.trim();
    return { verdict: command[1]!.toLowerCase() as "approve" | "deny", ...(rest === "" ? {} : { text: rest }) };
  }
  // Held input is only let in or dropped: the user's other words are their own message, which waits with it.
  if (kind === "admit") return null;
  // For a question any reply is the answer; for an approval it is a refusal that tells the agent why.
  return { verdict: kind === "question" ? "approve" : "deny", text: trimmed };
}

export const answerCallId = (payload: unknown): CallId | null => {
  const callId = (payload as { callId?: unknown } | null)?.callId;
  return typeof callId === "string" ? callId : null;
};
