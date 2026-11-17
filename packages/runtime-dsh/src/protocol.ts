/**
 * The part of the DeepSeek Harness SDK protocol this runtime speaks, written by hand from
 * `packages/sdk/protocol/src/types.ts` and `packages/sdk/server/src/server.ts` of dsh 0.2.2-rc.3.
 * Fields this runtime never reads are left out. Messages are JSON-RPC 2.0, one per line, on stdio.
 */

export type RequestId = string | number;

export type InitializeParams = {
  /** Working directory recorded on every session the SDK creates. */
  cwd: string;
  /** Lets the server send `approval/request` instead of leaving its in-process answerers in charge. */
  approvalRequests: boolean;
  provider: string;
  model: string;
  /** Lets the server ask this client instead of using its native in-process question answerer. */
  capabilities: { userQuestions?: boolean };
};

export type InitializeResult = { serverInfo: { name: string; version: string } };

export type PromptContentBlock = { type: "text"; text: string };

export type SessionPromptParams = { sessionId: string; contentBlocks: PromptContentBlock[] };

export type SessionPromptResult = { messageId: string };

export type SessionResumeParams = { sessionId: string };

/** One entry of the server's session log, as pushed by `session.event`. */
export type SessionEvent = { type: string; seq?: number; time?: number; data?: Record<string, unknown> };

export type SessionEventNotification = { sessionId: string; event: SessionEvent };

export type SessionStatusNotification = { sessionId: string; status: "idle" | "running" };

/** `tool/call`: the ordinary call a session logs before it asks for approval and runs the tool. */
export type ToolCallData = { callId: string; name: string; arguments?: unknown };

/** `tool/ptc-dispatch-start`: a tool call made from inside `run_code`; `subCallId` is its id. */
export type PtcDispatchStartData = { subCallId: string; name: string; arguments?: unknown };

export type ApprovalRequestParams = { sessionId: string; toolName: string; callId?: string; reason?: string };

/** Never anything else: aoa approves one call at a time. */
export type ApprovalRequestResult = { outcome: "allowed-once" | "rejected" | "cancelled" };

export type UserQuestionRequest = { requestId: string; sessionId: string; questions: unknown[] };

/** A dismissed question never counts as an answer. */
export type UserQuestionResult = { cancelled: true };
