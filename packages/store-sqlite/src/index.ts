import { Database } from "bun:sqlite";
import { type FSWatcher, watch as watchFile } from "node:fs";
import type {
  Beat,
  DecisionRecord,
  OutMsg,
  OutMsgDetail,
  PendingCall,
  Event,
  EventInsert,
  EventStatus,
  Grant,
  HostStore,
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
} from "@aoa-dev/kernel";
import { migrate } from "./schema.ts";

/** An application's own schema in the store's database file, versioned independently in `app_migrations`. */
export type AppSchema = {
  namespace: string;
  migrations: readonly string[];
};

/** An application's own handle on the store's SQLite connection, writing inside the store's transactions. */
export type SqliteApp = {
  readonly db: Database;
  write<T>(fn: () => T): T;
};

/**
 * The SQLite store. `app` opens an application's own tables on the same connection; `db` remains for compatibility,
 * and the kernel never reads application tables.
 */
export type SqliteStore = HostStore & {
  readonly db: Database;
  app(schema: AppSchema): SqliteApp;
};

export type SqliteStoreOptions = {
  /**
   * Whether `watch` also watches the WAL file, which sees another process's commit within a millisecond. Without it,
   * or when the watch drops a write (fs.watch does, on macOS, across a burst of commits), a check of `data_version`
   * every second finds it. Default true.
   */
  watchFile?: boolean;
};

/** How often `watch` checks `data_version` for another connection's commit. */
const VERSION_CHECK_MS = 1_000;

/** Opens (and migrates) a store on a file path or `:memory:`. */
export function sqliteStore(path: string, o: SqliteStoreOptions = {}): SqliteStore {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const t = createTx(db);
  const memory = path === ":memory:" || path === "";
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version");
  const totalChanges = db.query<{ n: number }, []>("SELECT total_changes() AS n");
  const getBeat = db.query<Beat, []>("SELECT pid, since, seen FROM host_beat WHERE id = 1");
  const putBeat = db.query(
    `INSERT INTO host_beat (id, pid, since, seen) VALUES (1, $pid, $since, $seen)
     ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, since = excluded.since, seen = excluded.seen`,
  );

  type Watcher = { fn: () => void; othersOnly: boolean };
  const watchers = new Set<Watcher>();
  let notifying: { own: boolean; others: boolean } | null = null;
  const notify = (from: "own" | "others") => {
    if (notifying) {
      notifying[from] = true;
      return;
    }
    notifying = { own: from === "own", others: from === "others" };
    // After the commit, once per burst: a watcher that reads or writes the store runs outside the transaction.
    queueMicrotask(() => {
      const n = notifying!;
      notifying = null;
      for (const w of [...watchers]) if (n.others || !w.othersOnly) w.fn();
    });
  };
  let lastVersion = 0;
  const checkOthers = () => {
    const v = dataVersion.get()!.data_version;
    if (v !== lastVersion) {
      lastVersion = v;
      notify("others");
    }
  };
  let stopSources: (() => void) | null = null;
  const startSources = () => {
    lastVersion = dataVersion.get()!.data_version;
    const check = setInterval(checkOthers, VERSION_CHECK_MS);
    check.unref();
    let file: FSWatcher | null = null;
    if (!memory && o.watchFile !== false) {
      try {
        file = watchFile(`${path}-wal`, () => checkOthers());
        file.unref();
      } catch {
        // No WAL file yet: the check above finds the commits.
      }
    }
    return () => {
      clearInterval(check);
      file?.close();
    };
  };

  let depth = 0;
  const runTx = <T>(fn: (t: Tx) => T): T => {
    if (depth > 0) {
      depth++;
      try {
        return db.transaction(() => fn(t)).immediate();
      } finally {
        depth--;
      }
    }
    depth++;
    try {
      if (watchers.size === 0) return db.transaction(() => fn(t)).immediate();
      const before = totalChanges.get()!.n;
      const result = db.transaction(() => fn(t)).immediate();
      if (totalChanges.get()!.n !== before) notify("own");
      return result;
    } finally {
      depth--;
    }
  };
  const getAppVersion = db.query<{ version: number }, [string]>("SELECT version FROM app_migrations WHERE namespace = ?");
  const putAppVersion = db.query(
    `INSERT INTO app_migrations (namespace, version) VALUES ($ns, $v)
     ON CONFLICT (namespace) DO UPDATE SET version = excluded.version`,
  );

  return {
    tx: runTx,
    db,
    app(schema) {
      runTx(() => {
        const current = getAppVersion.get(schema.namespace)?.version ?? 0;
        if (current > schema.migrations.length) {
          throw new Error(
            `This database was written by a newer ${schema.namespace} (app schema version ${current}); this version knows up to ${schema.migrations.length}.`,
          );
        }
        for (let v = current; v < schema.migrations.length; v++) db.exec(schema.migrations[v]!);
        if (current !== schema.migrations.length) putAppVersion.run({ ns: schema.namespace, v: schema.migrations.length });
      });
      return {
        db,
        write: (fn) => runTx(() => fn()),
      };
    },
    lock() {
      if (memory) return null;
      const held = new Database(`${path}-host`, { create: true });
      try {
        held.exec("PRAGMA busy_timeout = 0");
        held.exec("BEGIN EXCLUSIVE");
      } catch {
        held.close();
        const b = getBeat.get();
        throw new Error(
          `Another host runs this store's loops${b ? ` (pid ${b.pid}, since ${new Date(b.since).toISOString()})` : ""}; stop it first.`,
        );
      }
      let since: number | null = null;
      return {
        beat(at) {
          since ??= at;
          putBeat.run({ pid: process.pid, since, seen: at });
        },
        release() {
          held.exec("ROLLBACK");
          held.close();
        },
      };
    },
    lastBeat: () => getBeat.get() ?? null,
    watch(fn, w = {}) {
      const watcher = { fn, othersOnly: w.othersOnly ?? false };
      watchers.add(watcher);
      stopSources ??= startSources();
      return () => {
        watchers.delete(watcher);
        if (watchers.size === 0) {
          stopSources?.();
          stopSources = null;
        }
      };
    },
    close() {
      watchers.clear();
      stopSources?.();
      stopSources = null;
      db.close();
    },
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
  seq: number;
  id: string;
  inbox_id: string;
  session_id: string;
  thread: string | null;
  kind: OutMsg["kind"];
  body: string;
  call_id: string | null;
  detail: string | null;
  dedupe_key: string;
  created_at: number;
  status: OutMsg["status"];
  attempts: number;
  next_attempt_at: number;
  sent_at: number | null;
};

const toOutMsg = (r: OutboxRow): OutMsg => ({
  id: r.id,
  inboxId: r.inbox_id,
  sessionId: r.session_id,
  thread: r.thread,
  kind: r.kind,
  body: r.body,
  callId: r.call_id,
  detail: r.detail === null ? null : (JSON.parse(r.detail) as OutMsgDetail),
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

type GrantRow = {
  call_id: string;
  session_id: string;
  tool: string;
  args: string;
  granted_at: number;
  used_by: string | null;
};

const toGrant = (r: GrantRow): Grant => ({
  callId: r.call_id,
  sessionId: r.session_id,
  tool: r.tool,
  args: JSON.parse(r.args),
  grantedAt: r.granted_at,
  usedBy: r.used_by,
});

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
    listEventsBySession: db.query<EventRow, [string, string]>(
      "SELECT * FROM events WHERE inbox_id = ? AND resume = ? ORDER BY seq",
    ),
    listEventsByThread: db.query<EventRow, [string, string]>(
      "SELECT * FROM events WHERE inbox_id = ? AND thread = ? ORDER BY seq",
    ),
    listEventsByStatus: db.query<EventRow, [string, string]>(
      "SELECT * FROM events WHERE inbox_id = ? AND status = ? ORDER BY seq",
    ),
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
    pinEvent: db.query("UPDATE events SET resume = $session WHERE id = $id AND status = 'pending'"),
    dropEvent: db.query("UPDATE events SET status = 'dropped' WHERE id = $id AND status = 'pending'"),
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
    listThreads: db.query<{ thread_key: string }, [string]>("SELECT thread_key FROM threads WHERE session_id = ? ORDER BY rowid"),
    insertRun: db.query(
      "INSERT INTO runs (id, inbox_id, session_id, events, started_at) VALUES ($id, $inbox, $session, $events, $at)",
    ),
    endRun: db.query('UPDATE runs SET ended_at = $at, "end" = $end, error = $error WHERE id = $id'),
    listRuns: db.query<RunRow, [string]>("SELECT * FROM runs WHERE inbox_id = ? ORDER BY started_at, rowid"),
    listRunsBySession: db.query<RunRow, [string, string]>(
      "SELECT * FROM runs WHERE inbox_id = ? AND session_id = ? ORDER BY started_at, rowid",
    ),
    activeRun: db.query<{ run: string | null }, [string, string, number]>(
      "SELECT run FROM events WHERE inbox_id = ?1 AND resume = ?2 AND status = 'in_run' AND lease_until > ?3 LIMIT 1",
    ),
    requestAbort: db.query("UPDATE runs SET abort_requested = 1 WHERE id = ? AND ended_at IS NULL"),
    isAbortRequested: db.query<{ abort_requested: number }, [string]>("SELECT abort_requested FROM runs WHERE id = ?"),
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
    updateTimer: db.query(
      "UPDATE timers SET due = $due, recurrence = $recurrence, payload = $payload, session_id = $session, status = 'armed' WHERE id = $id",
    ),
    cancelTimer: db.query("UPDATE timers SET status = 'cancelled' WHERE id = $id AND status = 'armed'"),
    cancelFollowUp: db.query(
      "UPDATE timers SET status = 'cancelled' WHERE id = $id AND session_id = $session AND kind = 'follow_up' AND status = 'armed'",
    ),
    cancelTimersForSession: db.query("UPDATE timers SET status = 'cancelled' WHERE session_id = $session AND status = 'armed'"),
    insertOutMsg: db.query(
      `INSERT OR IGNORE INTO outbox (id, inbox_id, session_id, thread, kind, body, call_id, detail, dedupe_key, created_at, next_attempt_at, run_id)
       VALUES ($id, $inbox, $session, $thread, $kind, $body, $call, $detail, $dedupe, $at, $at, $run)`,
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
    insertGrant: db.query(
      "INSERT INTO grants (call_id, session_id, tool, args, granted_at) VALUES ($call, $session, $tool, $args, $at)",
    ),
    listGrants: db.query<GrantRow, [string]>("SELECT * FROM grants WHERE session_id = ? ORDER BY granted_at, rowid"),
    useGrant: db.query("UPDATE grants SET used_by = $by WHERE call_id = $call AND used_by IS NULL"),
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
    listEvents(inboxId, filter) {
      const raw =
        filter?.sessionId !== undefined
          ? q.listEventsBySession.all(inboxId, filter.sessionId)
          : filter?.thread !== undefined
            ? q.listEventsByThread.all(inboxId, filter.thread)
            : filter?.status !== undefined
              ? q.listEventsByStatus.all(inboxId, filter.status)
              : q.listEvents.all(inboxId);
      return raw
        .filter(
          (r) =>
            (filter?.sessionId === undefined || r.resume === filter.sessionId) &&
            (filter?.thread === undefined || r.thread === filter.thread) &&
            (filter?.status === undefined || r.status === filter.status),
        )
        .map(toEvent);
    },
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
    pinEvents(ids, session) {
      for (const id of ids) q.pinEvent.run({ id, session });
    },
    dropEvents(ids) {
      for (const id of ids) q.dropEvent.run({ id });
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
    listThreads: (session) => q.listThreads.all(session).map((r) => r.thread_key),
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
    listRuns: (inboxId, filter): RunRecord[] => {
      const raw = filter?.sessionId !== undefined ? q.listRunsBySession.all(inboxId, filter.sessionId) : q.listRuns.all(inboxId);
      return raw.map((r) => ({
        id: r.id,
        inboxId: r.inbox_id,
        sessionId: r.session_id,
        events: JSON.parse(r.events),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        end: r.end === null ? null : (JSON.parse(r.end) as RunEnd),
        error: r.error,
      }));
    },
    activeRun: (inboxId, sessionId, now) => q.activeRun.get(inboxId, sessionId, now)?.run ?? null,
    requestAbort: (runId) => q.requestAbort.run(runId).changes > 0,
    isAbortRequested: (runId) => q.isAbortRequested.get(runId)?.abort_requested === 1,
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
    updateTimer(id, tm) {
      q.updateTimer.run({
        id,
        due: tm.due,
        recurrence: tm.recurrence === null ? null : json(tm.recurrence),
        payload: json(tm.payload),
        session: tm.sessionId,
      });
    },
    cancelTimer: (id) => q.cancelTimer.run({ id }).changes > 0,
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
        detail: m.detail === undefined || m.detail === null ? null : json(m.detail),
        dedupe: m.dedupeKey,
        at: m.createdAt,
        run: m.runId ?? null,
      });
      return q.outMsgByKey.get(m.inboxId, m.dedupeKey)!.id;
    },
    listOutbox: (inboxId) => q.listOutbox.all(inboxId).map((r) => ({ ...toOutMsg(r), seq: r.seq, sentAt: r.sent_at })),
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
    insertGrant(g) {
      q.insertGrant.run({ call: g.callId, session: g.sessionId, tool: g.tool, args: json(g.args), at: g.grantedAt });
    },
    listGrants: (session) => q.listGrants.all(session).map(toGrant),
    useGrant(callId, usedBy) {
      q.useGrant.run({ call: callId, by: usedBy });
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
