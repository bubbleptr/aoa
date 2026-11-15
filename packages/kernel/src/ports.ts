import type {
  CallId,
  Event,
  EventId,
  EventSource,
  EventStatus,
  InboxId,
  JournalEntry,
  RunEnd,
  RunId,
  RunInput,
  RunRecord,
  RunResult,
  Session,
  SessionId,
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

export interface Tx {
  /** True if this inbox holds a non-dropped event with this `(source, dedupeKey)`. */
  isAccepted(inboxId: InboxId, source: EventSource, dedupeKey: string): boolean;
  insertEvent(e: EventInsert): void;
  getEvent(id: EventId): Event | null;
  listEvents(inboxId: InboxId): Event[];
  /** Pending events, oldest first by insertion order. */
  listPending(inboxId: InboxId): Event[];

  /** `in_run` events whose lease ended go back to `pending` with `attempts + 1`, or to `dead` at `maxAttempts`. */
  expireLeases(inboxId: InboxId, now: number, maxAttempts: number): void;
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
  /** A failed attempt: the run's events go back to `pending` with `attempts + 1`, or to `dead` at `maxAttempts`. */
  releaseEvents(run: RunId, maxAttempts: number): void;

  sessionForThread(inboxId: InboxId, thread: string): SessionId | null;
  registerThread(inboxId: InboxId, thread: string, session: SessionId): void;
  insertSession(s: { id: SessionId; inboxId: InboxId; createdAt: number }): void;
  getSession(id: SessionId): Session | null;
  recordSessionRun(id: SessionId, run: RunId, runtimeRef: string | null): void;

  insertRun(r: { id: RunId; inboxId: InboxId; sessionId: SessionId; events: EventId[]; startedAt: number }): void;
  endRun(id: RunId, outcome: { end: RunEnd } | { error: string }, endedAt: number): void;
  listRuns(inboxId: InboxId): RunRecord[];

  getJournal(session: SessionId, call: CallId): JournalEntry | null;
  recordIntent(e: { inboxId: InboxId; sessionId: SessionId; callId: CallId; tool: string; args: unknown; at: number }): void;
  recordResult(session: SessionId, call: CallId, result: ToolResult, at: number): void;
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
