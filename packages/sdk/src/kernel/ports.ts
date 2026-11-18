import type { OutMsg } from "./channel.ts";
import type {
  CallId,
  DecisionRecord,
  PendingCall,
  Event,
  EventId,
  Grant,
  EventSource,
  EventStatus,
  InboxId,
  JournalEntry,
  MsgId,
  RunEnd,
  RunId,
  HarnessRunInput,
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

/** The last heartbeat of the host that runs the loops on a store. */
export type Beat = { pid: number; since: number; seen: number };

/** The right to run the loops on a store, held until released or until the process that holds it ends. */
export interface Lock {
  /** Records that the holder still runs; the first beat is its start. */
  beat(at: number): void;
  release(): void;
}

/** What a host needs of a store beyond transactions (design §15). */
export interface HostStore extends Store {
  /**
   * Takes the lock, or returns null for a store only this process can open (`:memory:`). Throws while another
   * holder, in this process or another, has it.
   */
  lock(): Lock | null;
  /** The last heartbeat recorded by whoever held the lock; null if no host ever did. */
  lastBeat(): Beat | null;
  /**
   * Calls `fn` after commits: this connection's write transactions, and other connections' commits (another process)
   * within about a second. With `othersOnly`, only the latter. Returns what stops it.
   */
  watch(fn: () => void, o?: { othersOnly?: boolean }): () => void;
  close(): void;
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

/**
 * An outbox row as the store keeps it: `seq` orders every inbox's messages in one queue, so a later message has a
 * higher `seq` whatever its inbox; `sentAt` is when it was delivered.
 */
export type OutboxRow = OutMsg & { seq: number; sentAt: number | null };

/** An undelivered message and the earliest time it may be tried. */
export type QueuedMsg = { msg: OutMsg; nextAttemptAt: number };

/**
 * When the events of a failed attempt may be claimed again: given how many times they have failed and when
 * the attempt ended (for an expired lease, when the lease ran out).
 */
export type RetryAt = (attempts: number, failedAt: number) => number;

export interface Tx {
  /** True if this inbox holds a non-dropped event with this `(source, dedupeKey)`, or consumed the key as an answer. */
  isAccepted(inboxId: InboxId, source: EventSource, dedupeKey: string): boolean;
  /** Records that an event with this key was taken in as an answer under another key, so a redelivery is dropped. */
  consumeKey(inboxId: InboxId, source: EventSource, dedupeKey: string): void;
  insertEvent(e: EventInsert): void;
  getEvent(id: EventId): Event | null;
  listEvents(inboxId: InboxId, filter?: { sessionId?: SessionId; thread?: string; status?: EventStatus }): Event[];
  /** Pending events, oldest first by insertion order; they may still be waiting out a retry delay (`nextAttemptAt`). */
  listPending(inboxId: InboxId): Event[];

  /**
   * `in_run` events whose lease ended go back to `pending` with `attempts + 1` and a `next_attempt_at` of
   * `retryAt(attempts + 1, leaseUntil)`, or to `dead` at `maxAttempts`. Returns the events that went `dead`, oldest first.
   */
  expireLeases(inboxId: InboxId, now: number, maxAttempts: number, retryAt: RetryAt): Event[];
  /** The latest unexpired lease held in this inbox, or null if no run holds one. */
  activeLease(inboxId: InboxId, now: number): number | null;
  /**
   * `pending → in_run` for exactly these events, pinning them to `session`.
   * Returns false and changes nothing if any of them is no longer pending, is still waiting out a retry delay,
   * or the inbox already holds an unexpired lease.
   */
  claimEvents(inboxId: InboxId, ids: EventId[], run: RunId, session: SessionId, now: number, leaseUntil: number): boolean;
  /** Pins these pending events to `session` without claiming them, so they wait with it (design §12). */
  pinEvents(ids: EventId[], session: SessionId): void;
  /** `pending → dropped` for these events. */
  dropEvents(ids: EventId[]): void;
  /** Returns false if the run no longer holds its events. */
  renewLease(run: RunId, leaseUntil: number): boolean;
  /** `in_run → done` for the events this run still holds; returns how many. */
  completeEvents(run: RunId): number;
  /**
   * A failed attempt: the run's events go back to `pending` with `attempts + 1` and a `next_attempt_at` of
   * `retryAt(attempts + 1, now)`, or to `dead` at `maxAttempts`. Returns the events that went `dead`, oldest first.
   */
  releaseEvents(run: RunId, now: number, maxAttempts: number, retryAt: RetryAt): Event[];

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
  /** Every thread of the session, in the order registered: the primary one first. */
  listThreads(session: SessionId): string[];
  markTainted(id: SessionId): void;
  /** Pauses the session on `callId`, or reopens it with nothing pending when `callId` is null. */
  setSessionPending(id: SessionId, callId: CallId | null): void;

  insertDeferred(d: PendingCall): void;
  getDeferred(callId: CallId): PendingCall | null;
  deleteDeferred(callId: CallId): void;
  /** Oldest first. */
  listDeferred(inboxId: InboxId): PendingCall[];
  insertGrant(g: Omit<Grant, "usedBy">): void;
  /** The session's grants, used or not, oldest first. */
  listGrants(session: SessionId): Grant[];
  useGrant(callId: CallId, usedBy: CallId): void;
  recordDecision(d: DecisionRecord): void;
  /** Oldest first. */
  listDecisions(session: SessionId): DecisionRecord[];

  insertRun(r: { id: RunId; inboxId: InboxId; sessionId: SessionId; events: EventId[]; startedAt: number }): void;
  endRun(id: RunId, outcome: { end: RunEnd } | { error: string }, endedAt: number): void;
  listRuns(inboxId: InboxId, filter?: { sessionId?: SessionId }): RunRecord[];
  /** The run currently holding an unexpired lease on `sessionId` in `inboxId`, or null if none does. */
  activeRun(inboxId: InboxId, sessionId: SessionId, now: number): RunId | null;
  /** Marks a running `runId` as requested to abort (for cross-process `agent.abort`); returns whether an unfinished run matched. */
  requestAbort(runId: RunId): boolean;
  /** True if `requestAbort` was recorded for `runId`. */
  isAbortRequested(runId: RunId): boolean;

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
  /** Replaces a timer's schedule and payload and arms it again, whatever its status was. */
  updateTimer(id: TimerId, t: Pick<Timer, "due" | "recurrence" | "payload" | "sessionId">): void;
  /** Cancels an armed timer of any kind; returns whether one was cancelled. */
  cancelTimer(id: TimerId): boolean;
  /** Cancels an armed follow-up that belongs to `session`; returns whether one was cancelled. */
  cancelFollowUp(id: TimerId, session: SessionId): boolean;
  /** Cancels every armed timer of the session (D-TMR-6); returns how many. */
  cancelTimersForSession(session: SessionId): number;

  /** Inserts a pending message. If the inbox already holds its `dedupeKey`, inserts nothing and returns the existing id. */
  insertOutMsg(m: OutMsgInsert): MsgId;
  /** Every message of the inbox, in the order they were queued. */
  listOutbox(inboxId: InboxId): OutboxRow[];
  /** An undelivered approval request for `callId` becomes `cancelled`, so it is never sent. */
  cancelApprovalRequest(callId: CallId): void;
  /** `sending → pending`: what a dispatcher that died mid-delivery left behind. */
  resetSending(inboxId: InboxId): void;
  /** Pending and sending messages, oldest first. */
  listUndelivered(inboxId: InboxId): QueuedMsg[];
  /** `pending → sending`; returns false if the message is not pending. */
  markSending(id: MsgId): boolean;
  markSent(id: MsgId, at: number): void;
  /**
   * `attempts + 1`, then back to `pending` until `nextAttemptAt`, or `failed` when it is null.
   * A message that is no longer `sending` (cancelled mid-delivery) is left alone.
   */
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

/**
 * A runtime with no tools of its own (design §15, tier 1): every call it makes goes through `input.tools[i].invoke`,
 * so the kernel decides, journals and executes it.
 */
export interface KernelRuntime {
  readonly kind: "kernel";
  run(input: RunInput): Promise<RunResult>;
}

/**
 * A harness that brings its own tools (design §15, tier 2). The kernel neither decides nor executes them; the
 * harness asks through `input.ask` and the kernel relays the ask to the user (design §12). The kernel also holds
 * untrusted input until the user admits it, since nothing it can see guards what the harness does with it.
 */
export interface HarnessRuntime {
  readonly kind: "harness";
  run(input: HarnessRunInput): Promise<RunResult>;
}

export type AgentRuntime = KernelRuntime | HarnessRuntime;

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
