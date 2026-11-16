import type { Database } from "bun:sqlite";

/** Each entry upgrades the schema by one `user_version`. Append only; never edit a shipped migration. */
const migrations: string[] = [
  `
  CREATE TABLE events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    inbox_id    TEXT NOT NULL,
    source      TEXT NOT NULL,
    dedupe_key  TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    payload     TEXT NOT NULL,
    thread      TEXT,
    resume      TEXT,
    trusted     INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending', 'in_run', 'done', 'dropped', 'dead')),
    lease_until INTEGER,
    attempts    INTEGER NOT NULL DEFAULT 0,
    run         TEXT
  );
  CREATE UNIQUE INDEX events_dedupe ON events (inbox_id, source, dedupe_key) WHERE status <> 'dropped';
  CREATE INDEX events_inbox_status ON events (inbox_id, status);
  CREATE INDEX events_run ON events (run);

  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    inbox_id    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'closed')),
    pending     TEXT,
    runtime_ref TEXT,
    workdir     TEXT,
    last_run    TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE threads (
    inbox_id   TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    PRIMARY KEY (inbox_id, thread_key)
  );

  CREATE TABLE runs (
    id         TEXT PRIMARY KEY,
    inbox_id   TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    events     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    "end"      TEXT,
    error      TEXT
  );
  CREATE INDEX runs_inbox ON runs (inbox_id, started_at);

  CREATE TABLE tool_journal (
    session_id TEXT NOT NULL,
    call_id    TEXT NOT NULL,
    inbox_id   TEXT NOT NULL,
    tool       TEXT NOT NULL,
    args       TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('intent', 'done')),
    result     TEXT,
    intent_at  INTEGER NOT NULL,
    result_at  INTEGER,
    PRIMARY KEY (session_id, call_id)
  );
  `,
  `
  CREATE TABLE timers (
    id         TEXT PRIMARY KEY,
    inbox_id   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('follow_up', 'schedule')),
    session_id TEXT REFERENCES sessions (id),
    due        INTEGER NOT NULL,
    recurrence TEXT,
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'done', 'cancelled')),
    last_fired INTEGER,
    CHECK ((kind = 'schedule') = (recurrence IS NOT NULL))
  );
  CREATE INDEX timers_due ON timers (inbox_id, status, due);
  CREATE INDEX timers_session ON timers (session_id, status);
  `,
  `
  CREATE TABLE outbox (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    inbox_id        TEXT NOT NULL,
    session_id      TEXT NOT NULL REFERENCES sessions (id),
    thread          TEXT,
    kind            TEXT NOT NULL CHECK (kind IN ('message', 'approval_request')),
    body            TEXT NOT NULL,
    call_id         TEXT,
    dedupe_key      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    sent_at         INTEGER,
    run_id          TEXT,
    UNIQUE (inbox_id, dedupe_key)
  );
  CREATE INDEX outbox_status ON outbox (inbox_id, status);
  CREATE INDEX outbox_session ON outbox (session_id, run_id);

  CREATE TABLE cursors (
    inbox_id TEXT NOT NULL,
    name     TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (inbox_id, name)
  );
  `,
  `
  ALTER TABLE sessions ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE deferred (
    call_id      TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions (id),
    inbox_id     TEXT NOT NULL,
    tool         TEXT NOT NULL,
    args         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('approval', 'question')),
    requested_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );

  CREATE TABLE decisions (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool       TEXT NOT NULL,
    decision   TEXT NOT NULL CHECK (decision IN ('allow', 'block', 'defer')),
    basis      TEXT NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE INDEX decisions_session ON decisions (session_id);
  `,
  `
  CREATE TABLE consumed_keys (
    inbox_id   TEXT NOT NULL,
    source     TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    PRIMARY KEY (inbox_id, source, dedupe_key)
  );
  `,
  `
  CREATE TABLE pull_states (
    session_id TEXT PRIMARY KEY REFERENCES sessions (id),
    number     INTEGER NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
    checked_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE declared_results (
    session_id TEXT PRIMARY KEY REFERENCES sessions (id),
    result     TEXT NOT NULL CHECK (result IN ('merged', 'discarded')),
    applied    INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- When a failed attempt's events may be claimed again (design §9). 0 means "not waiting".
  ALTER TABLE events ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- A shadow judge's score for one classifier call (design §12). One row per call; p is NULL when it failed.
  CREATE TABLE judgments (
    call_id    TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    model      TEXT NOT NULL,
    p          REAL,
    latency_ms INTEGER NOT NULL,
    error      TEXT,
    at         INTEGER NOT NULL
  );
  CREATE INDEX judgments_at ON judgments (at);
  `,
];

/** Reads the version inside the write transaction so two connections opening a new file cannot both migrate. */
export function migrate(db: Database): void {
  db.transaction(() => {
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < migrations.length; v++) db.exec(migrations[v]!);
    db.exec(`PRAGMA user_version = ${migrations.length}`);
  }).immediate();
}
