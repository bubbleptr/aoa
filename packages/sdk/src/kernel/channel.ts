import type { CallId, EventId, InboxId, MsgId, NewEvent, PendingCall, SessionId } from "./types.ts";

export type MsgStatus = "pending" | "sending" | "sent" | "failed" | "cancelled";
export type MsgKind = "message" | "approval_request";

/**
 * Structured payload for system-generated outbox messages, so a channel can render interactive cards, buttons or
 * localized copy without parsing `body`. Plain `notify` / reply messages have `detail: null`.
 */
export type OutMsgDetail =
  | {
      kind: "approval";
      requestKind: PendingCall["kind"];
      callId: CallId;
      tool: string;
      args: unknown;
      reason?: string;
      expiresAt: number;
    }
  | {
      kind: "dead_letter";
      events: EventId[];
      error: string | null;
    };

/** A row of the outbox (spec §7.2). */
export type OutMsg = {
  id: MsgId;
  inboxId: InboxId;
  sessionId: SessionId;
  /** Where the message goes, in the same form as `Event.thread`; null if the session has no thread. */
  thread: string | null;
  kind: MsgKind;
  body: string;
  /** The deferred call an `approval_request` asks about. */
  callId: CallId | null;
  /** Structured metadata for approvals and dead-letter notices; null for ordinary messages. */
  detail?: OutMsgDetail | null;
  dedupeKey: string;
  createdAt: number;
  status: MsgStatus;
  attempts: number;
};

/** Where messages leave and outside events enter. The kernel knows nothing else about the outside. */
export interface Channel {
  /** Must be safe to call again with the same `dedupeKey` after a failure (I-OUT-2). */
  deliver(m: OutMsg): Promise<void>;
  /**
   * Events since `cursor`. The caller stores the returned cursor in the same transaction as the events. A channel
   * whose events arrive some other way (pushed, or appended by the caller) has none and is never polled.
   */
  poll?(cursor: string | null): Promise<{ events: NewEvent[]; cursor: string }>;
}
