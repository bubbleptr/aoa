import type { OutMsg } from "./channel.ts";
import type {
  CallId,
  DecisionRecord,
  PendingCall,
  Event,
  EventId,
  EventSource,
  EventStatus,
  InboxId,
  JournalEntry,
  MsgId,
  RunEnd,
  RunId,
  RunInput,
  RunRecord,
  RunResult,
  Session,
  SessionId,
  SessionStatus,
  Timer,
  TimerId,
  ToolResult,
} from "./types.ts";

/** One call to `tx` is one database transaction: the spec's ATOMIC. */
export interface Store {
  tx<T>(fn: (t: Tx) => T): T;
}

export type EventInsert = {
  id: EventId;
  inboxId: InboxId;
  source: EventSource;
  dedupeKey: string;
  receivedAt: number;
  payload: unknown;
  thread: string | null;
  resume: SessionId | null;
  trusted: boolean;
  status: Extract<EventStatus, "pending" | "dropped">;
};

export type JournalRecord = JournalEntry & { intentAt: number; resultAt: number | null };

export type OutMsgInsert = Omit<OutMsg, "status" | "attempts"> & {
  /** The run the message belongs to, when it is known at insert time; otherwise the session's next run claims it. */
  runId?: RunId;
};

/** An undelivered message and the earliest time it may be tried. */
export type QueuedMsg = { msg: OutMsg; nextAttemptAt: number };

export interface Tx {
  /** True if this inbox holds a non-dropped event with this `(source, dedupeKey)`, or consumed the key as an answer. */
  isAccepted(inboxId: InboxId, source: EventSource, dedupeKey: string): boolean;
  /** Records that an event with this key was taken in as an answer under another key, so a redelivery is dropped. */
  consumeKey(inboxId: InboxId, source: EventSource, dedupeKey: string): void;
  insertEvent(e: EventInsert): void;
  getEvent(id: EventId): Event | null;
  listEvents(inboxId: InboxId): Event[];
  /** Pending events, oldest first by insertion order. */
  listPending(inboxId: InboxId): Event[];

  /**
   * `in_run` events whose lease ended go back to `pending` with `attempts + 1`, or to `dead` at `maxAttempts`.
   * Returns the events that went `dead`, oldest first.
   */
  expireLeases(inboxId: InboxId, now: number, maxAttempts: number): Event[];
  /** The latest unexpired lease held in this inbox, or null if no run holds one. */
  activeLease(inboxId: InboxId, now: number): number | null;
  /**
   * `pending → in_run` for exactly these events, pinning them to `session`.
   * Returns false and changes nothing if any of them is no longer pending
   * or the inbox already holds an unexpired lease.
   */
  claimEvents(inboxId: InboxId, ids: EventId[], run: RunId, session: SessionId, now: number, leaseUntil: number): boolean;
  /** Returns false if the run no longer holds its events. */
  renewLease(run: RunId, leaseUntil: number): boolean;
  /** `in_run → done` for the events this run still holds; returns how many. */
  completeEvents(run: RunId): number;
  /**
   * A failed attempt: the run's events go back to `pending` with `attempts + 1`, or to `dead` at `maxAttempts`.
   * Returns the events that went `dead`, oldest first.
   */
  releaseEvents(run: RunId, maxAttempts: number): Event[];

  sessionForThread(inboxId: InboxId, thread: string): SessionId | null;
  registerThread(inboxId: InboxId, thread: string, session: SessionId): void;
  insertSession(s: { id: SessionId; inboxId: InboxId; createdAt: number }): void;
  getSession(id: SessionId): Session | null;
  recordSessionRun(id: SessionId, run: RunId, runtimeRef: string | null): void;
  /** Null when the workdir was removed, so the next run of the session prepares a new one. */
  setSessionWorkdir(id: SessionId, workdir: string | null): void;
  /** Oldest first. */
  listSessions(inboxId: InboxId): Session[];
  setSessionStatus(id: SessionId, status: Extract<SessionStatus, "open" | "closed">): void;
  /** The first thread registered for the session: where its messages go. Null if it has none. */
  primaryThread(session: SessionId): string | null;
  markTainted(id: SessionId): void;
  /** Pauses the session on `callId`, or reopens it with nothing pending when `callId` is null. */
  setSessionPending(id: SessionId, callId: CallId | null): void;

  insertDeferred(d: PendingCall): void;
  getDeferred(callId: CallId): PendingCall | null;
  deleteDeferred(callId: CallId): void;
  /** Oldest first. */
  listDeferred(inboxId: InboxId): PendingCall[];
  recordDecision(d: DecisionRecord): void;
  /** Oldest first. */
  listDecisions(session: SessionId): DecisionRecord[];

  insertRun(r: { id: RunId; inboxId: InboxId; sessionId: SessionId; events: EventId[]; startedAt: number }): void;
  endRun(id: RunId, outcome: { end: RunEnd } | { error: string }, endedAt: number): void;
  listRuns(inboxId: InboxId): RunRecord[];

  getJournal(session: SessionId, call: CallId): JournalEntry | null;
  /** The session's journal, in the order the intents were recorded. */
  listJournal(session: SessionId): JournalRecord[];
  recordIntent(e: { inboxId: InboxId; sessionId: SessionId; callId: CallId; tool: string; args: unknown; at: number }): void;
  recordResult(session: SessionId, call: CallId, result: ToolResult, at: number): void;

  /** Returns false and changes nothing if a timer with this id already exists. */
  insertTimer(t: Omit<Timer, "status" | "lastFired">): boolean;
  getTimer(id: TimerId): Timer | null;
  listTimers(inboxId: InboxId): Timer[];
  /** Armed timers with `due <= now`, earliest first. */
  listDueTimers(inboxId: InboxId, now: number): Timer[];
  /** The earliest `due` among armed timers, or null if none is armed. */
  nextTimerDue(inboxId: InboxId): number | null;
  /**
   * Records that `occurrence` fired: `last_fired ← occurrence`, then either `done` (`nextDue` null)
   * or `due ← nextDue`. Applies only while the timer is armed with `due = occurrence`; returns whether it did.
   */
  fireTimer(id: TimerId, occurrence: number, nextDue: number | null): boolean;
  /** Cancels an armed follow-up that belongs to `session`; returns whether one was cancelled. */
  cancelFollowUp(id: TimerId, session: SessionId): boolean;
  /** Cancels every armed timer of the session (D-TMR-6); returns how many. */
  cancelTimersForSession(session: SessionId): number;

  /** Inserts a pending message. If the inbox already holds its `dedupeKey`, inserts nothing and returns the existing id. */
  insertOutMsg(m: OutMsgInsert): MsgId;
  listOutbox(inboxId: InboxId): OutMsg[];
  /** An undelivered approval request for `callId` becomes `cancelled`, so it is never sent. */
  cancelApprovalRequest(callId: CallId): void;
  /** `sending → pending`: what a dispatcher that died mid-delivery left behind. */
  resetSending(inboxId: InboxId): void;
  /** Pending and sending messages, oldest first. */
  listUndelivered(inboxId: InboxId): QueuedMsg[];
  /** `pending → sending`; returns false if the message is not pending. */
  markSending(id: MsgId): boolean;
  markSent(id: MsgId, at: number): void;
  /** `attempts + 1`, then back to `pending` until `nextAttemptAt`, or `failed` when it is null. */
  markDeliveryFailed(id: MsgId, nextAttemptAt: number | null): void;
  /** When messages of kind `message` were sent at or after `since`. */
  listSentTimes(inboxId: InboxId, since: number): number[];
  listFailed(inboxId: InboxId): OutMsg[];
  /** The last `limit` delivered messages of kind `message`, oldest first. */
  listRecentSent(inboxId: InboxId, limit: number): OutMsg[];
  /** Attributes the session's messages that no run has claimed yet to `run`; returns their ids, oldest first. */
  claimRunMessages(session: SessionId, run: RunId): MsgId[];

  getCursor(inboxId: InboxId, name: string): string | null;
  setCursor(inboxId: InboxId, name: string, value: string): void;
}

export interface AgentRuntime {
  run(input: RunInput): Promise<RunResult>;
}

/** Wall-clock time and timers. All waiting in the kernel goes through this port. */
export interface Clock {
  now(): number;
  /** Calls `fn` once after `ms`; the returned function cancels it. */
  setTimer(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};
