import { Database } from "bun:sqlite";
import type {
  DecisionRecord,
  OutMsg,
  PendingCall,
  Event,
  EventInsert,
  EventStatus,
  JournalEntry,
  JournalRecord,
  RunEnd,
  RetryAt,
  RunRecord,
  Session,
  SessionStatus,
  Store,
  Timer,
  ToolResult,
  Tx,
} from "@aoa/kernel";
import { migrate } from "./schema.ts";

export type PullState = { number: number; state: "open" | "merged" | "closed"; checkedAt: number };

/**
 * The last known state of each session's pull request, as `aoa status` last saw it on GitHub.
 * It lives outside `Tx` because the kernel knows nothing of pull requests.
 */
export type PullStates = {
  get(sessionId: string): PullState | null;
  set(sessionId: string, s: PullState): void;
};

/** How the user says a local-mode session's branch ended (`aoa close`). `applied` once serve has closed the session for it. */
export type DeclaredResult = { result: "merged" | "discarded"; applied: boolean };

export type DeclaredResults = {
  get(sessionId: string): DeclaredResult | null;
  /** Records or replaces the declaration, not yet applied. */
  declare(sessionId: string, result: DeclaredResult["result"]): void;
  markApplied(sessionId: string): void;
};

export type SqliteStore = Store & {
  pulls: PullStates;
  results: DeclaredResults;
  /** When the session's first message of kind `message` was delivered; null if none was. */
  firstMessageSentAt(sessionId: string): number | null;
  /** When each delivered message of the inbox was sent, by message id. */
  sentTimes(inboxId: string): Map<string, number>;
  /** SQLite's `data_version`: it changes whenever another connection commits to the database. */
  dataVersion(): number;
  close(): void;
};

/** Opens (and migrates) a store on a file path or `:memory:`. */
export function sqliteStore(path: string): SqliteStore {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const t = createTx(db);
  const getPull = db.query<{ number: number; state: PullState["state"]; checked_at: number }, [string]>(
    "SELECT number, state, checked_at FROM pull_states WHERE session_id = ?",
  );
  const setPull = db.query(
    `INSERT INTO pull_states (session_id, number, state, checked_at) VALUES ($session, $number, $state, $at)
     ON CONFLICT (session_id) DO UPDATE SET number = excluded.number, state = excluded.state, checked_at = excluded.checked_at`,
  );
  const getResult = db.query<{ result: DeclaredResult["result"]; applied: number }, [string]>(
    "SELECT result, applied FROM declared_results WHERE session_id = ?",
  );
  const declareResult = db.query(
    `INSERT INTO declared_results (session_id, result, applied) VALUES ($session, $result, 0)
     ON CONFLICT (session_id) DO UPDATE SET result = excluded.result, applied = 0`,
  );
  const applyResult = db.query("UPDATE declared_results SET applied = 1 WHERE session_id = ?");
  const firstSent = db.query<{ at: number | null }, [string]>(
    "SELECT MIN(sent_at) AS at FROM outbox WHERE session_id = ? AND kind = 'message' AND status = 'sent'",
  );
  const sentTimes = db.query<{ id: string; sent_at: number }, [string]>(
    "SELECT id, sent_at FROM outbox WHERE inbox_id = ? AND sent_at IS NOT NULL",
  );
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version");
  return {
    tx: (fn) => db.transaction(() => fn(t)).immediate(),
    pulls: {
      get(sessionId) {
        const r = getPull.get(sessionId);
        return r ? { number: r.number, state: r.state, checkedAt: r.checked_at } : null;
      },
      set(sessionId, p) {
        setPull.run({ session: sessionId, number: p.number, state: p.state, at: p.checkedAt });
      },
    },
    results: {
      get(sessionId) {
        const r = getResult.get(sessionId);
        return r ? { result: r.result, applied: r.applied === 1 } : null;
      },
      declare(sessionId, result) {
        declareResult.run({ session: sessionId, result });
      },
      markApplied(sessionId) {
        applyResult.run(sessionId);
      },
    },
    firstMessageSentAt: (sessionId) => firstSent.get(sessionId)?.at ?? null,
    sentTimes: (inboxId) => new Map(sentTimes.all(inboxId).map((r) => [r.id, r.sent_at])),
    dataVersion: () => dataVersion.get()!.data_version,
    close: () => db.close(),
  };
}

type EventRow = {
  seq: number;
  id: string;
  inbox_id: string;
  source: Event["source"];
  dedupe_key: string;
  received_at: number;
  payload: string;
  thread: string | null;
  resume: string | null;
  trusted: number;
  status: EventStatus;
  lease_until: number | null;
  attempts: number;
  next_attempt_at: number;
  run: string | null;
};

const toEvent = (r: EventRow): Event => ({
  id: r.id,
  inboxId: r.inbox_id,
  source: r.source,
  dedupeKey: r.dedupe_key,
  receivedAt: r.received_at,
  payload: JSON.parse(r.payload),
  thread: r.thread,
  resume: r.resume,
  trusted: r.trusted === 1,
  status: r.status,
  leaseUntil: r.lease_until,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  run: r.run,
});

type SessionRow = {
  id: string;
  inbox_id: string;
  status: SessionStatus;
  pending: string | null;
  runtime_ref: string | null;
  workdir: string | null;
  last_run: string | null;
  created_at: number;
  tainted: number;
};

type RunRow = {
  id: string;
  inbox_id: string;
  session_id: string;
  events: string;
  started_at: number;
  ended_at: number | null;
  end: string | null;
  error: string | null;
};

type JournalRow = {
  session_id: string;
  call_id: string;
  tool: string;
  args: string;
  state: "intent" | "done";
  result: string | null;
  intent_at: number;
  result_at: number | null;
};

const toJournal = (r: JournalRow): JournalRecord => ({
  sessionId: r.session_id,
  callId: r.call_id,
  tool: r.tool,
  args: JSON.parse(r.args),
  state: r.state,
  result: r.result === null ? null : (JSON.parse(r.result) as ToolResult),
  intentAt: r.intent_at,
  resultAt: r.result_at,
});

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  inboxId: r.inbox_id,
  status: r.status,
  pending: r.pending,
  runtimeRef: r.runtime_ref,
  workdir: r.workdir,
  lastRun: r.last_run,
  createdAt: r.created_at,
  tainted: r.tainted === 1,
});

const toDeferred = (r: DeferredRow): PendingCall => ({
  callId: r.call_id,
  sessionId: r.session_id,
  inboxId: r.inbox_id,
  tool: r.tool,
  args: JSON.parse(r.args),
  kind: r.kind,
  requestedAt: r.requested_at,
  expiresAt: r.expires_at,
});

type TimerRow = {
  id: string;
  inbox_id: string;
  kind: Timer["kind"];
  session_id: string | null;
  due: number;
  recurrence: string | null;
  payload: string;
  status: Timer["status"];
  last_fired: number | null;
};

const toTimer = (r: TimerRow): Timer => ({
  id: r.id,
  inboxId: r.inbox_id,
  kind: r.kind,
  sessionId: r.session_id,
  due: r.due,
  recurrence: r.recurrence === null ? null : JSON.parse(r.recurrence),
  payload: JSON.parse(r.payload),
  status: r.status,
  lastFired: r.last_fired,
});

type OutboxRow = {
  id: string;
  inbox_id: string;
  session_id: string;
  thread: string | null;
  kind: OutMsg["kind"];
  body: string;
  call_id: string | null;
  dedupe_key: string;
  created_at: number;
  status: OutMsg["status"];
  attempts: number;
  next_attempt_at: number;
};

const toOutMsg = (r: OutboxRow): OutMsg => ({
  id: r.id,
  inboxId: r.inbox_id,
  sessionId: r.session_id,
  thread: r.thread,
  kind: r.kind,
  body: r.body,
  callId: r.call_id,
  dedupeKey: r.dedupe_key,
  createdAt: r.created_at,
  status: r.status,
  attempts: r.attempts,
});

type DeferredRow = {
  call_id: string;
  session_id: string;
  inbox_id: string;
  tool: string;
  args: string;
  kind: PendingCall["kind"];
  requested_at: number;
  expires_at: number;
};

type DecisionRow = {
  call_id: string;
  session_id: string;
  tool: string;
  decision: DecisionRecord["decision"];
  basis: string;
  at: number;
};

const json = (v: unknown): string => JSON.stringify(v ?? null);

function createTx(db: Database): Tx {
  const q = {
    isAccepted: db.query<{ n: number }, [string, string, string]>(
      `SELECT (SELECT count(*) FROM events WHERE inbox_id = ?1 AND source = ?2 AND dedupe_key = ?3 AND status <> 'dropped')
            + (SELECT count(*) FROM consumed_keys WHERE inbox_id = ?1 AND source = ?2 AND dedupe_key = ?3) AS n`,
    ),
    consumeKey: db.query(
      "INSERT OR IGNORE INTO consumed_keys (inbox_id, source, dedupe_key) VALUES ($inbox, $source, $dedupe)",
    ),
    insertEvent: db.query(
      `INSERT INTO events (id, inbox_id, source, dedupe_key, received_at, payload, thread, resume, trusted, status)
       VALUES ($id, $inbox, $source, $dedupe, $received, $payload, $thread, $resume, $trusted, $status)`,
    ),
    getEvent: db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?"),
    listEvents: db.query<EventRow, [string]>("SELECT * FROM events WHERE inbox_id = ? ORDER BY seq"),
    listPending: db.query<EventRow, [string]>(
      "SELECT * FROM events WHERE inbox_id = ? AND status = 'pending' ORDER BY seq",
    ),
    expireLeases: db.query(
      `UPDATE events
       SET status = CASE WHEN attempts + 1 >= $max THEN 'dead' ELSE 'pending' END,
           attempts = attempts + 1
       WHERE inbox_id = $inbox AND status = 'in_run' AND lease_until <= $now
       RETURNING id, attempts, status, lease_until`,
    ),
    activeLease: db.query<{ until: number | null }, [string, number]>(
      "SELECT max(lease_until) AS until FROM events WHERE inbox_id = ? AND status = 'in_run' AND lease_until > ?",
    ),
    isPending: db.query<{ n: number }, [string, number]>(
      "SELECT count(*) AS n FROM events WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?",
    ),
    claim: db.query(
      `UPDATE events SET status = 'in_run', run = $run, resume = $session, lease_until = $lease
       WHERE id = $id AND status = 'pending'`,
    ),
    renewLease: db.query("UPDATE events SET lease_until = $lease WHERE run = $run AND status = 'in_run'"),
    completeEvents: db.query("UPDATE events SET status = 'done', lease_until = NULL WHERE run = $run AND status = 'in_run'"),
    releaseEvents: db.query(
      `UPDATE events
       SET status = CASE WHEN attempts + 1 >= $max THEN 'dead' ELSE 'pending' END,
           attempts = attempts + 1
       WHERE run = $run AND status = 'in_run'
       RETURNING id, attempts, status, lease_until`,
    ),
    setNextAttempt: db.query("UPDATE events SET next_attempt_at = $at, lease_until = NULL WHERE id = $id"),
    clearLease: db.query("UPDATE events SET lease_until = NULL WHERE id = $id"),
    sessionForThread: db.query<{ session_id: string }, [string, string]>(
      "SELECT session_id FROM threads WHERE inbox_id = ? AND thread_key = ?",
    ),
    registerThread: db.query(
      "INSERT OR IGNORE INTO threads (inbox_id, thread_key, session_id) VALUES ($inbox, $thread, $session)",
    ),
    insertSession: db.query("INSERT INTO sessions (id, inbox_id, created_at) VALUES ($id, $inbox, $at)"),
    getSession: db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?"),
    listSessions: db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE inbox_id = ? ORDER BY created_at, rowid"),
    recordSessionRun: db.query("UPDATE sessions SET last_run = $run, runtime_ref = $ref WHERE id = $id"),
    setSessionWorkdir: db.query("UPDATE sessions SET workdir = $workdir WHERE id = $id"),
    setSessionStatus: db.query("UPDATE sessions SET status = $status WHERE id = $id"),
    primaryThread: db.query<{ thread_key: string }, [string]>(
      "SELECT thread_key FROM threads WHERE session_id = ? ORDER BY rowid LIMIT 1",
    ),
    insertRun: db.query(
      "INSERT INTO runs (id, inbox_id, session_id, events, started_at) VALUES ($id, $inbox, $session, $events, $at)",
    ),
    endRun: db.query('UPDATE runs SET ended_at = $at, "end" = $end, error = $error WHERE id = $id'),
    listRuns: db.query<RunRow, [string]>("SELECT * FROM runs WHERE inbox_id = ? ORDER BY started_at, rowid"),
    getJournal: db.query<JournalRow, [string, string]>(
      "SELECT * FROM tool_journal WHERE session_id = ? AND call_id = ?",
    ),
    listJournal: db.query<JournalRow, [string]>("SELECT * FROM tool_journal WHERE session_id = ? ORDER BY intent_at, rowid"),
    recordIntent: db.query(
      `INSERT INTO tool_journal (session_id, call_id, inbox_id, tool, args, state, intent_at)
       VALUES ($session, $call, $inbox, $tool, $args, 'intent', $at)`,
    ),
    recordResult: db.query(
      "UPDATE tool_journal SET state = 'done', result = $result, result_at = $at WHERE session_id = $session AND call_id = $call",
    ),
    insertTimer: db.query(
      `INSERT OR IGNORE INTO timers (id, inbox_id, kind, session_id, due, recurrence, payload)
       VALUES ($id, $inbox, $kind, $session, $due, $recurrence, $payload)`,
    ),
    getTimer: db.query<TimerRow, [string]>("SELECT * FROM timers WHERE id = ?"),
    listTimers: db.query<TimerRow, [string]>("SELECT * FROM timers WHERE inbox_id = ? ORDER BY due, rowid"),
    listDueTimers: db.query<TimerRow, [string, number]>(
      "SELECT * FROM timers WHERE inbox_id = ? AND status = 'armed' AND due <= ? ORDER BY due, rowid",
    ),
    nextTimerDue: db.query<{ due: number | null }, [string]>(
      "SELECT min(due) AS due FROM timers WHERE inbox_id = ? AND status = 'armed'",
    ),
    fireTimer: db.query(
      `UPDATE timers
       SET last_fired = $occurrence,
           status = CASE WHEN $next IS NULL THEN 'done' ELSE 'armed' END,
           due = coalesce($next, due)
       WHERE id = $id AND status = 'armed' AND due = $occurrence`,
    ),
    cancelFollowUp: db.query(
      "UPDATE timers SET status = 'cancelled' WHERE id = $id AND session_id = $session AND kind = 'follow_up' AND status = 'armed'",
    ),
    cancelTimersForSession: db.query("UPDATE timers SET status = 'cancelled' WHERE session_id = $session AND status = 'armed'"),
    insertOutMsg: db.query(
      `INSERT OR IGNORE INTO outbox (id, inbox_id, session_id, thread, kind, body, call_id, dedupe_key, created_at, next_attempt_at, run_id)
       VALUES ($id, $inbox, $session, $thread, $kind, $body, $call, $dedupe, $at, $at, $run)`,
    ),
    outMsgByKey: db.query<{ id: string }, [string, string]>("SELECT id FROM outbox WHERE inbox_id = ? AND dedupe_key = ?"),
    listOutbox: db.query<OutboxRow, [string]>("SELECT * FROM outbox WHERE inbox_id = ? ORDER BY seq"),
    cancelApprovalRequest: db.query(
      "UPDATE outbox SET status = 'cancelled' WHERE call_id = $call AND kind = 'approval_request' AND status IN ('pending', 'sending')",
    ),
    resetSending: db.query("UPDATE outbox SET status = 'pending' WHERE inbox_id = $inbox AND status = 'sending'"),
    listUndelivered: db.query<OutboxRow, [string]>(
      "SELECT * FROM outbox WHERE inbox_id = ? AND status IN ('pending', 'sending') ORDER BY seq",
    ),
    markSending: db.query("UPDATE outbox SET status = 'sending' WHERE id = $id AND status = 'pending'"),
    markSent: db.query("UPDATE outbox SET status = 'sent', sent_at = $at WHERE id = $id"),
    markDeliveryFailed: db.query(
      `UPDATE outbox
       SET attempts = attempts + 1,
           status = CASE WHEN $next IS NULL THEN 'failed' ELSE 'pending' END,
           next_attempt_at = coalesce($next, next_attempt_at)
       WHERE id = $id AND status = 'sending'`,
    ),
    listSentTimes: db.query<{ sent_at: number }, [string, number]>(
      "SELECT sent_at FROM outbox WHERE inbox_id = ? AND kind = 'message' AND status = 'sent' AND sent_at >= ? ORDER BY sent_at",
    ),
    listRecentSent: db.query<OutboxRow, [string, number]>(
      "SELECT * FROM outbox WHERE inbox_id = ? AND kind = 'message' AND status = 'sent' ORDER BY sent_at DESC, seq DESC LIMIT ?",
    ),
    listFailed: db.query<OutboxRow, [string]>("SELECT * FROM outbox WHERE inbox_id = ? AND status = 'failed' ORDER BY seq"),
    claimRunMessages: db.query<{ id: string; seq: number }, [string, string]>(
      "UPDATE outbox SET run_id = ?2 WHERE session_id = ?1 AND kind = 'message' AND run_id IS NULL RETURNING id, seq",
    ),
    markTainted: db.query("UPDATE sessions SET tainted = 1 WHERE id = $id"),
    setSessionPending: db.query(
      "UPDATE sessions SET pending = $call, status = CASE WHEN $call IS NULL THEN 'open' ELSE 'paused' END WHERE id = $id",
    ),
    insertDeferred: db.query(
      `INSERT INTO deferred (call_id, session_id, inbox_id, tool, args, kind, requested_at, expires_at)
       VALUES ($call, $session, $inbox, $tool, $args, $kind, $requested, $expires)`,
    ),
    getDeferred: db.query<DeferredRow, [string]>("SELECT * FROM deferred WHERE call_id = ?"),
    listDeferred: db.query<DeferredRow, [string]>("SELECT * FROM deferred WHERE inbox_id = ? ORDER BY requested_at, rowid"),
    deleteDeferred: db.query("DELETE FROM deferred WHERE call_id = $call"),
    recordDecision: db.query(
      `INSERT INTO decisions (call_id, session_id, tool, decision, basis, at)
       VALUES ($call, $session, $tool, $decision, $basis, $at)`,
    ),
    listDecisions: db.query<DecisionRow, [string]>("SELECT * FROM decisions WHERE session_id = ? ORDER BY seq"),
    getCursor: db.query<{ value: string }, [string, string]>("SELECT value FROM cursors WHERE inbox_id = ? AND name = ?"),
    setCursor: db.query(
      `INSERT INTO cursors (inbox_id, name, value) VALUES ($inbox, $name, $value)
       ON CONFLICT (inbox_id, name) DO UPDATE SET value = excluded.value`,
    ),
  };

  /**
   * Takes a failed-attempt update's `RETURNING` rows: the pending ones wait until `retryAt(attempts, failedAt)`
   * before another claim, and the ones that went `dead` are returned as events in insertion order.
   * The update leaves `lease_until` alone, so an expired lease still says when the attempt ended.
   */
  const released = (
    changed: unknown[],
    retryAt: RetryAt,
    failedAt: (row: { id: string; lease_until: number | null }) => number,
  ): Event[] => {
    const rows = changed as { id: string; attempts: number; status: EventStatus; lease_until: number | null }[];
    for (const r of rows) {
      if (r.status === "pending") q.setNextAttempt.run({ id: r.id, at: retryAt(r.attempts, failedAt(r)) });
      else q.clearLease.run({ id: r.id });
    }
    return rows
      .filter((r) => r.status === "dead")
      .map((r) => q.getEvent.get(r.id)!)
      .sort((a, b) => a.seq - b.seq)
      .map(toEvent);
  };

  const activeLease = (inboxId: string, now: number) => q.activeLease.get(inboxId, now)?.until ?? null;

  return {
    isAccepted: (inboxId, source, dedupeKey) => q.isAccepted.get(inboxId, source, dedupeKey)!.n > 0,
    consumeKey(inboxId, source, dedupeKey) {
      q.consumeKey.run({ inbox: inboxId, source, dedupe: dedupeKey });
    },
    insertEvent(e: EventInsert) {
      q.insertEvent.run({
        id: e.id,
        inbox: e.inboxId,
        source: e.source,
        dedupe: e.dedupeKey,
        received: e.receivedAt,
        payload: json(e.payload),
        thread: e.thread,
        resume: e.resume,
        trusted: e.trusted ? 1 : 0,
        status: e.status,
      });
    },
    getEvent: (id) => {
      const r = q.getEvent.get(id);
      return r ? toEvent(r) : null;
    },
    listEvents: (inboxId) => q.listEvents.all(inboxId).map(toEvent),
    listPending: (inboxId) => q.listPending.all(inboxId).map(toEvent),
    expireLeases: (inboxId, now, maxAttempts, retryAt) =>
      // A lease that ran out failed when it ended, not when a worker noticed (design §9).
      released(q.expireLeases.all({ inbox: inboxId, now, max: maxAttempts }), retryAt, (r) => r.lease_until ?? now),
    activeLease,
    claimEvents(inboxId, ids, run, session, now, leaseUntil) {
      if (activeLease(inboxId, now) !== null) return false;
      if (!ids.every((id) => q.isPending.get(id, now)!.n === 1)) return false;
      for (const id of ids) q.claim.run({ id, run, session, lease: leaseUntil });
      return true;
    },
    renewLease: (run, leaseUntil) => q.renewLease.run({ run, lease: leaseUntil }).changes > 0,
    completeEvents: (run) => q.completeEvents.run({ run }).changes,
    // A run that threw failed now; its lease still runs to the end, which is not when the attempt ended.
    releaseEvents: (run, now, maxAttempts, retryAt) =>
      released(q.releaseEvents.all({ run, max: maxAttempts }), retryAt, () => now),
    sessionForThread: (inboxId, thread) => q.sessionForThread.get(inboxId, thread)?.session_id ?? null,
    registerThread(inboxId, thread, session) {
      q.registerThread.run({ inbox: inboxId, thread, session });
    },
    insertSession(s) {
      q.insertSession.run({ id: s.id, inbox: s.inboxId, at: s.createdAt });
    },
    getSession(id): Session | null {
      const r = q.getSession.get(id);
      return r ? toSession(r) : null;
    },
    listSessions: (inboxId) => q.listSessions.all(inboxId).map(toSession),
    recordSessionRun(id, run, runtimeRef) {
      q.recordSessionRun.run({ id, run, ref: runtimeRef });
    },
    setSessionWorkdir(id, workdir) {
      q.setSessionWorkdir.run({ id, workdir });
    },
    setSessionStatus(id, status) {
      q.setSessionStatus.run({ id, status });
    },
    primaryThread: (session) => q.primaryThread.get(session)?.thread_key ?? null,
    insertRun(r) {
      q.insertRun.run({ id: r.id, inbox: r.inboxId, session: r.sessionId, events: json(r.events), at: r.startedAt });
    },
    endRun(id, outcome, endedAt) {
      q.endRun.run({
        id,
        at: endedAt,
        end: "end" in outcome ? json(outcome.end) : null,
        error: "error" in outcome ? outcome.error : null,
      });
    },
    listRuns: (inboxId): RunRecord[] =>
      q.listRuns.all(inboxId).map((r) => ({
        id: r.id,
        inboxId: r.inbox_id,
        sessionId: r.session_id,
        events: JSON.parse(r.events),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        end: r.end === null ? null : (JSON.parse(r.end) as RunEnd),
        error: r.error,
      })),
    getJournal(session, call): JournalEntry | null {
      const r = q.getJournal.get(session, call);
      return r ? toJournal(r) : null;
    },
    listJournal: (session) => q.listJournal.all(session).map(toJournal),
    recordIntent(e) {
      q.recordIntent.run({
        session: e.sessionId,
        call: e.callId,
        inbox: e.inboxId,
        tool: e.tool,
        args: json(e.args),
        at: e.at,
      });
    },
    recordResult(session, call, result, at) {
      q.recordResult.run({ session, call, result: json(result), at });
    },
    insertTimer: (tm) =>
      q.insertTimer.run({
        id: tm.id,
        inbox: tm.inboxId,
        kind: tm.kind,
        session: tm.sessionId,
        due: tm.due,
        recurrence: tm.recurrence === null ? null : json(tm.recurrence),
        payload: json(tm.payload),
      }).changes > 0,
    getTimer: (id) => {
      const r = q.getTimer.get(id);
      return r ? toTimer(r) : null;
    },
    listTimers: (inboxId) => q.listTimers.all(inboxId).map(toTimer),
    listDueTimers: (inboxId, now) => q.listDueTimers.all(inboxId, now).map(toTimer),
    nextTimerDue: (inboxId) => q.nextTimerDue.get(inboxId)?.due ?? null,
    fireTimer: (id, occurrence, nextDue) => q.fireTimer.run({ id, occurrence, next: nextDue }).changes > 0,
    cancelFollowUp: (id, session) => q.cancelFollowUp.run({ id, session }).changes > 0,
    cancelTimersForSession: (session) => q.cancelTimersForSession.run({ session }).changes,
    insertOutMsg(m) {
      q.insertOutMsg.run({
        id: m.id,
        inbox: m.inboxId,
        session: m.sessionId,
        thread: m.thread,
        kind: m.kind,
        body: m.body,
        call: m.callId,
        dedupe: m.dedupeKey,
        at: m.createdAt,
        run: m.runId ?? null,
      });
      return q.outMsgByKey.get(m.inboxId, m.dedupeKey)!.id;
    },
    listOutbox: (inboxId) => q.listOutbox.all(inboxId).map(toOutMsg),
    cancelApprovalRequest(callId) {
      q.cancelApprovalRequest.run({ call: callId });
    },
    resetSending(inboxId) {
      q.resetSending.run({ inbox: inboxId });
    },
    listUndelivered: (inboxId) =>
      q.listUndelivered.all(inboxId).map((r) => ({ msg: toOutMsg(r), nextAttemptAt: r.next_attempt_at })),
    markSending: (id) => q.markSending.run({ id }).changes > 0,
    markSent(id, at) {
      q.markSent.run({ id, at });
    },
    markDeliveryFailed(id, nextAttemptAt) {
      q.markDeliveryFailed.run({ id, next: nextAttemptAt });
    },
    listSentTimes: (inboxId, since) => q.listSentTimes.all(inboxId, since).map((r) => r.sent_at),
    listRecentSent: (inboxId, limit) => q.listRecentSent.all(inboxId, limit).map(toOutMsg).reverse(),
    listFailed: (inboxId) => q.listFailed.all(inboxId).map(toOutMsg),
    claimRunMessages: (session, run) =>
      q.claimRunMessages
        .all(session, run)
        .sort((a, b) => a.seq - b.seq)
        .map((r) => r.id),
    markTainted(id) {
      q.markTainted.run({ id });
    },
    setSessionPending(id, callId) {
      q.setSessionPending.run({ id, call: callId });
    },
    insertDeferred(d) {
      q.insertDeferred.run({
        call: d.callId,
        session: d.sessionId,
        inbox: d.inboxId,
        tool: d.tool,
        args: json(d.args),
        kind: d.kind,
        requested: d.requestedAt,
        expires: d.expiresAt,
      });
    },
    getDeferred(callId): PendingCall | null {
      const r = q.getDeferred.get(callId);
      return r ? toDeferred(r) : null;
    },
    listDeferred: (inboxId) => q.listDeferred.all(inboxId).map(toDeferred),
    deleteDeferred(callId) {
      q.deleteDeferred.run({ call: callId });
    },
    recordDecision(d) {
      q.recordDecision.run({ call: d.callId, session: d.sessionId, tool: d.tool, decision: d.decision, basis: d.basis, at: d.at });
    },
    listDecisions: (session) =>
      q.listDecisions.all(session).map((r) => ({
        callId: r.call_id,
        sessionId: r.session_id,
        tool: r.tool,
        decision: r.decision,
        basis: r.basis,
        at: r.at,
      })),
    getCursor: (inboxId, name) => q.getCursor.get(inboxId, name)?.value ?? null,
    setCursor(inboxId, name, value) {
      q.setCursor.run({ inbox: inboxId, name, value });
    },
  };
}
