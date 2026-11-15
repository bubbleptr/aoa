import { Database } from "bun:sqlite";
import type {
  Event,
  EventInsert,
  EventStatus,
  JournalEntry,
  RunEnd,
  RunRecord,
  Session,
  SessionStatus,
  Store,
  ToolResult,
  Tx,
} from "@aoa/kernel";
import { migrate } from "./schema.ts";

export type SqliteStore = Store & { close(): void };

/** Opens (and migrates) a store on a file path or `:memory:`. */
export function sqliteStore(path: string): SqliteStore {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const t = createTx(db);
  return {
    tx: (fn) => db.transaction(() => fn(t)).immediate(),
    close: () => db.close(),
  };
}

type EventRow = {
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
};

const json = (v: unknown): string => JSON.stringify(v ?? null);

function createTx(db: Database): Tx {
  const q = {
    isAccepted: db.query<{ n: number }, [string, string]>(
      "SELECT count(*) AS n FROM events WHERE source = ? AND dedupe_key = ? AND status <> 'dropped'",
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
           attempts = attempts + 1, lease_until = NULL
       WHERE inbox_id = $inbox AND status = 'in_run' AND lease_until <= $now`,
    ),
    activeLease: db.query<{ until: number | null }, [string, number]>(
      "SELECT max(lease_until) AS until FROM events WHERE inbox_id = ? AND status = 'in_run' AND lease_until > ?",
    ),
    isPending: db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE id = ? AND status = 'pending'"),
    claim: db.query(
      `UPDATE events SET status = 'in_run', run = $run, resume = $session, lease_until = $lease
       WHERE id = $id AND status = 'pending'`,
    ),
    renewLease: db.query("UPDATE events SET lease_until = $lease WHERE run = $run AND status = 'in_run'"),
    completeEvents: db.query("UPDATE events SET status = 'done', lease_until = NULL WHERE run = $run AND status = 'in_run'"),
    releaseEvents: db.query(
      `UPDATE events
       SET status = CASE WHEN attempts + 1 >= $max THEN 'dead' ELSE 'pending' END,
           attempts = attempts + 1, lease_until = NULL
       WHERE run = $run AND status = 'in_run'`,
    ),
    sessionForThread: db.query<{ session_id: string }, [string, string]>(
      "SELECT session_id FROM threads WHERE inbox_id = ? AND thread_key = ?",
    ),
    registerThread: db.query(
      "INSERT OR IGNORE INTO threads (inbox_id, thread_key, session_id) VALUES ($inbox, $thread, $session)",
    ),
    insertSession: db.query("INSERT INTO sessions (id, inbox_id, created_at) VALUES ($id, $inbox, $at)"),
    getSession: db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?"),
    recordSessionRun: db.query("UPDATE sessions SET last_run = $run, runtime_ref = $ref WHERE id = $id"),
    insertRun: db.query(
      "INSERT INTO runs (id, inbox_id, session_id, events, started_at) VALUES ($id, $inbox, $session, $events, $at)",
    ),
    endRun: db.query('UPDATE runs SET ended_at = $at, "end" = $end, error = $error WHERE id = $id'),
    listRuns: db.query<RunRow, [string]>("SELECT * FROM runs WHERE inbox_id = ? ORDER BY started_at, rowid"),
    getJournal: db.query<JournalRow, [string, string]>(
      "SELECT * FROM tool_journal WHERE session_id = ? AND call_id = ?",
    ),
    recordIntent: db.query(
      `INSERT INTO tool_journal (session_id, call_id, inbox_id, tool, args, state, intent_at)
       VALUES ($session, $call, $inbox, $tool, $args, 'intent', $at)`,
    ),
    recordResult: db.query(
      "UPDATE tool_journal SET state = 'done', result = $result, result_at = $at WHERE session_id = $session AND call_id = $call",
    ),
  };

  const activeLease = (inboxId: string, now: number) => q.activeLease.get(inboxId, now)?.until ?? null;

  return {
    isAccepted: (source, dedupeKey) => q.isAccepted.get(source, dedupeKey)!.n > 0,
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
    expireLeases(inboxId, now, maxAttempts) {
      q.expireLeases.run({ inbox: inboxId, now, max: maxAttempts });
    },
    activeLease,
    claimEvents(inboxId, ids, run, session, now, leaseUntil) {
      if (activeLease(inboxId, now) !== null) return false;
      if (!ids.every((id) => q.isPending.get(id)!.n === 1)) return false;
      for (const id of ids) q.claim.run({ id, run, session, lease: leaseUntil });
      return true;
    },
    renewLease: (run, leaseUntil) => q.renewLease.run({ run, lease: leaseUntil }).changes > 0,
    completeEvents: (run) => q.completeEvents.run({ run }).changes,
    releaseEvents(run, maxAttempts) {
      q.releaseEvents.run({ run, max: maxAttempts });
    },
    sessionForThread: (inboxId, thread) => q.sessionForThread.get(inboxId, thread)?.session_id ?? null,
    registerThread(inboxId, thread, session) {
      q.registerThread.run({ inbox: inboxId, thread, session });
    },
    insertSession(s) {
      q.insertSession.run({ id: s.id, inbox: s.inboxId, at: s.createdAt });
    },
    getSession(id): Session | null {
      const r = q.getSession.get(id);
      if (!r) return null;
      return {
        id: r.id,
        inboxId: r.inbox_id,
        status: r.status,
        pending: r.pending,
        runtimeRef: r.runtime_ref,
        workdir: r.workdir,
        lastRun: r.last_run,
        createdAt: r.created_at,
      };
    },
    recordSessionRun(id, run, runtimeRef) {
      q.recordSessionRun.run({ id, run, ref: runtimeRef });
    },
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
      if (!r) return null;
      return {
        sessionId: r.session_id,
        callId: r.call_id,
        tool: r.tool,
        args: JSON.parse(r.args),
        state: r.state,
        result: r.result === null ? null : (JSON.parse(r.result) as ToolResult),
      };
    },
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
  };
}
