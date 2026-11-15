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
];

/** Reads the version inside the write transaction so two connections opening a new file cannot both migrate. */
export function migrate(db: Database): void {
  db.transaction(() => {
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < migrations.length; v++) db.exec(migrations[v]!);
    db.exec(`PRAGMA user_version = ${migrations.length}`);
  }).immediate();
}
