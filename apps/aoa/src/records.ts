import type { SqliteStore } from "@aoa/store-sqlite";

/**
 * What the app keeps beside the kernel's tables, in the same database file (design §15「store 收口」): the last known
 * state of each pull request, how the user said a local-mode branch ended, and the shadow judge's scores. The tables
 * were created by the store's early migrations and stay there; only the app reads or writes them.
 */
export type PullState = { number: number; state: "open" | "merged" | "closed"; checkedAt: number };

/** How the user says a local-mode session's branch ended (`aoa close`). `applied` once serve has closed the session for it. */
export type DeclaredResult = { result: "merged" | "discarded"; applied: boolean };

/** A shadow judge's score for one classifier call (design §12). `p` is null when the judge failed. */
export type Judgment = {
  callId: string;
  sessionId: string;
  /** The model that answered, as its response named it. */
  model: string;
  /** The probability of yes, 0 to 1; null on failure. */
  p: number | null;
  latencyMs: number;
  /** Why the judge failed; null on success. */
  error: string | null;
  at: number;
};

export type Records = {
  pulls: {
    get(sessionId: string): PullState | null;
    set(sessionId: string, s: PullState): void;
  };
  results: {
    get(sessionId: string): DeclaredResult | null;
    /** Records or replaces the declaration, not yet applied. */
    declare(sessionId: string, result: DeclaredResult["result"]): void;
    markApplied(sessionId: string): void;
  };
  judgments: {
    /** One row per judged call; judging the same call again replaces its row. */
    record(j: Judgment): void;
    /** Judgments of this inbox's sessions at or after `since`, oldest first. */
    list(inboxId: string, since: number): Judgment[];
  };
};

type JudgmentRow = {
  call_id: string;
  session_id: string;
  model: string;
  p: number | null;
  latency_ms: number;
  error: string | null;
  at: number;
};

/**
 * On the store's own connection, so a write here never waits on the store's transaction; each write is a store
 * transaction, so the store's `watch` (and the observation page) sees it like any other.
 */
export function records(store: SqliteStore): Records {
  const { db } = store;
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
  const recordJudgment = db.query(
    `INSERT INTO judgments (call_id, session_id, model, p, latency_ms, error, at)
     VALUES ($call, $session, $model, $p, $latency, $error, $at)
     ON CONFLICT (call_id) DO UPDATE SET
       session_id = excluded.session_id, model = excluded.model, p = excluded.p,
       latency_ms = excluded.latency_ms, error = excluded.error, at = excluded.at`,
  );
  const listJudgments = db.query<JudgmentRow, [string, number]>(
    `SELECT j.* FROM judgments j JOIN sessions s ON s.id = j.session_id
     WHERE s.inbox_id = ?1 AND j.at >= ?2 ORDER BY j.at, j.rowid`,
  );
  return {
    pulls: {
      get(sessionId) {
        const r = getPull.get(sessionId);
        return r ? { number: r.number, state: r.state, checkedAt: r.checked_at } : null;
      },
      set(sessionId, p) {
        store.tx(() => setPull.run({ session: sessionId, number: p.number, state: p.state, at: p.checkedAt }));
      },
    },
    results: {
      get(sessionId) {
        const r = getResult.get(sessionId);
        return r ? { result: r.result, applied: r.applied === 1 } : null;
      },
      declare(sessionId, result) {
        store.tx(() => declareResult.run({ session: sessionId, result }));
      },
      markApplied(sessionId) {
        store.tx(() => applyResult.run(sessionId));
      },
    },
    judgments: {
      record(j) {
        store.tx(() =>
          recordJudgment.run({ call: j.callId, session: j.sessionId, model: j.model, p: j.p, latency: j.latencyMs, error: j.error, at: j.at }),
        );
      },
      list: (inboxId, since) =>
        listJudgments.all(inboxId, since).map((r) => ({
          callId: r.call_id,
          sessionId: r.session_id,
          model: r.model,
          p: r.p,
          latencyMs: r.latency_ms,
          error: r.error,
          at: r.at,
        })),
    },
  };
}
