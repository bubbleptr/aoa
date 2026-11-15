import type { CallId, InboxId, MsgId, NewEvent, SessionId } from "./types.ts";

export type MsgStatus = "pending" | "sending" | "sent" | "failed" | "cancelled";
export type MsgKind = "message" | "approval_request";

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
  dedupeKey: string;
  createdAt: number;
  status: MsgStatus;
  attempts: number;
};

/** Where messages leave and outside events enter. The kernel knows nothing else about the outside. */
export interface Channel {
  /** Must be safe to call again with the same `dedupeKey` after a failure (I-OUT-2). */
  deliver(m: OutMsg): Promise<void>;
  /** Events since `cursor`. The caller stores the returned cursor in the same transaction as the events. */
  poll(cursor: string | null): Promise<{ events: NewEvent[]; cursor: string }>;
}
