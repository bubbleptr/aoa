import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Decision, type DecisionRecord, type EventSource, type EventStatus, type Event, type JournalRecord, type OutMsg, type OutboxRow as QueuedRow, type PendingCall, RESIDENT_RECENT_MESSAGES, type Tx } from "@aoa/kernel";
import { SERVING_STALE_MS } from "@aoa/sdk";
import { asks } from "./status.ts";
import type { Agent } from "./wiring.ts";

/** A heartbeat older than this means `serve` is not running: three missed nudges. */
export const SERVE_STALE_MS = SERVING_STALE_MS;

const DAY_MS = 24 * 60 * 60_000;
/** The shadow judge's summary window (design §12). */
const WEEK_MS = 7 * DAY_MS;
const LATEST = 8;
const OPEN_LIMIT = 20;

export const EDGES = ["in", "claim", "calls", "set", "memory", "says", "fires", "delivered"] as const;
export type Edge = (typeof EDGES)[number];

type Count = { total: number; last24h: number };

export type InboxRow = {
  id: string;
  source: EventSource;
  thread: string | null;
  sessionId: string | null;
  status: EventStatus | "retrying";
  attempts: number;
  receivedAt: number;
  /** When a retrying event may be claimed again; null otherwise. */
  nextAttemptAt: number | null;
  run: string | null;
  leaseUntil: number | null;
};

export type TimerRow = {
  id: string;
  kind: "follow_up" | "schedule";
  /** The session its event resumes; null when it opens a new one. */
  sessionId: string | null;
  /** That session's thread, where its reply goes. */
  thread: string | null;
  status: "armed" | "done" | "cancelled";
  due: number;
  everyMs: number | null;
  lastFired: number | null;
  /** The payload the agent gets: a note as written, anything else as JSON. Null for an expiry timer, whose event is an answer. */
  text: string | null;
  /** For the timer that expires a deferred call: that call. */
  expiresCall: string | null;
};

/** The most of one memory file's text a snapshot carries, in bytes. */
export const MEMORY_FILE_CAP = 64 * 1024;
/** The most memory text a snapshot carries in all, in bytes; the latest files get it first. */
export const MEMORY_TOTAL_CAP = 512 * 1024;

/**
 * When a run sees the file (design §7): instructions and the index are loaded into every run, a progress file into
 * its own task's runs, notes only when the agent reads them; anything else is not part of the layout.
 */
export type MemoryKind = "instructions" | "index" | "progress" | "notes" | "other";

export type MemoryFile = {
  path: string;
  kind: MemoryKind;
  /** For a progress file: the task it belongs to, by its name, and that task's state; `unknown` if no such task. */
  task: { sessionId: string; state: "open" | "paused" | "closed" | "unknown" } | null;
  size: number;
  mtime: number;
  writtenBy: string | null;
  /** The file's text, or its head when `truncated`; null when it is not UTF-8. */
  text: string | null;
  truncated: boolean;
  binary: boolean;
};

/** A shadow judge's answer for one call: its probability of yes, or why it has none. */
export type JevScore = { model: string; p: number | null; error: string | null; latencyMs: number };
/** `high` is p >= 0.9, `mid` is 0.5 to 0.9, `low` is below 0.5. */
export type JevBucket = "high" | "mid" | "low";
export type ShadowSummary = {
  /** Classifier calls Jev was asked about in the last seven days, including its failures. */
  judged: number;
  /** Of those, how many have no p. */
  failed: number;
  /** The classifier's verdict by Jev's bucket; a failed judgment is in no bucket. */
  matrix: Record<"allow" | "block" | "unsure", Record<JevBucket, number>>;
};

export type WaitingCall = {
  callId: string;
  sessionId: string;
  tool: string;
  args: string;
  basis: string | null;
  /** The shadow judge's score for this call, if it was configured and answered. */
  jev: JevScore | null;
  askedAt: number;
  expiresAt: number;
  answer: string;
  kind: PendingCall["kind"];
  /** What the call asks, unclipped: the page shows this before it offers to answer. */
  full: string;
  /** An answer already queued for the session to pick up; the call stays waiting until a run takes it. */
  answered: "approve" | "deny" | null;
};

export type DecisionRow = {
  callId: string;
  sessionId: string;
  tool: string;
  args: string | null;
  decision: Decision;
  basis: string;
  at: number;
  /** The classifier's verdict when this row is its decision; null for a rule, risk tier or answer. */
  classifier: "allow" | "block" | "unsure" | null;
  /** The shadow judge's score for this call, if it was configured and answered. */
  jev: JevScore | null;
  /** What the user answered, when the call was deferred to them. */
  userAnswer: "approve" | "deny" | null;
};

export type OutboxRow = {
  id: string;
  kind: OutMsg["kind"];
  thread: string | null;
  sessionId: string;
  body: string;
  status: OutMsg["status"];
  attempts: number;
  createdAt: number;
  sentAt: number | null;
  /** For an approval request: whether its call still waits, was answered, or the request was withdrawn. */
  approval: "pending" | "answered" | "cancelled" | null;
};

/** What `aoa web` shows, read from the store and the memory directory at `at`. Every time in it is absolute. */
export type Snapshot = {
  at: number;
  inboxId: string;
  serve: { state: "running" | "offline" | "never"; startedAt: number | null; seenAt: number | null };
  worker: { runId: string; sessionId: string | null; startedAt: number | null; leaseUntil: number; events: number } | null;
  nextTimer: { id: string; kind: TimerRow["kind"]; due: number } | null;
  events: { counts: Record<InboxRow["status"], number>; rows: InboxRow[] };
  timers: { counts: { armed: number; schedule: number; done: number; cancelled: number }; rows: TimerRow[] };
  memory: {
    root: string;
    files: MemoryFile[];
    totalBytes: number;
    writesToday: { sessionId: string; count: number }[];
    /** What every run is given as "already told the user": the latest delivered messages, oldest first. */
    told: { id: string; thread: string | null; body: string; createdAt: number }[];
  };
  permissions: {
    waiting: WaitingCall[];
    last24h: Record<Decision, number>;
    /** Defers and blocks of the last 24 hours, latest first. */
    recent: DecisionRow[];
    allowsByBasis: { basis: string; count: number }[];
    /** The shadow judge's last seven days; zero everywhere when it is not configured or has not run. */
    shadow: ShadowSummary;
  };
  outbox: { counts: Record<OutMsg["status"], number>; rows: OutboxRow[] };
  edges: Record<Edge, Count>;
  /** Of the events counted on the `in` edge, those another agent sent with send_to. */
  inFromAgents: Count;
  /** The next moment the snapshot changes with no write: serve going stale, a retry delay or a lease running out. */
  nextChangeAt: number | null;
};

const memoryPath = (path: unknown): string | null =>
  typeof path === "string" ? path.split(/[\\/]+/).filter((p) => p !== "" && p !== ".").join("/") : null;

const PROGRESS_FILE = /^progress\/([^/]+)\.md$/;

function kindOf(path: string): MemoryKind {
  if (path === "instructions.md") return "instructions";
  if (path === "index.md") return "index";
  if (PROGRESS_FILE.test(path)) return "progress";
  if (path.startsWith("notes/")) return "notes";
  return "other";
}

function listFiles(root: string): MemoryFile[] {
  const files: MemoryFile[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      // A `.tmp` file is a memory write halfway through its rename.
      else if (e.isFile() && !e.name.endsWith(".tmp")) {
        const st = statSync(full);
        const path = relative(root, full).split(sep).join("/");
        files.push({ path, kind: kindOf(path), task: null, size: st.size, mtime: st.mtimeMs, writtenBy: null, text: null, truncated: false, binary: false });
      }
    }
  };
  walk(root);
  files.sort((a, b) => b.mtime - a.mtime);
  let budget = MEMORY_TOTAL_CAP;
  for (const f of files) {
    const read = readHead(join(root, f.path), Math.min(MEMORY_FILE_CAP, budget));
    if (read === null) continue;
    if (read.text === null) {
      f.binary = true;
      continue;
    }
    f.text = read.text;
    f.truncated = read.truncated;
    budget -= read.bytes;
  }
  return files;
}

/**
 * At most `cap` bytes of a file, decoded as UTF-8 and cut back to a whole character. Its text is null when the bytes
 * read are not UTF-8; the result is null when the file went away since it was listed.
 */
function readHead(path: string, cap: number): { text: string | null; bytes: number; truncated: boolean } | null {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    // One byte past the cap tells a file of exactly `cap` bytes from a longer one.
    const buf = Buffer.alloc(cap + 1);
    const n = readSync(fd, buf, 0, cap + 1, 0);
    const truncated = n > cap;
    const head = buf.subarray(0, Math.min(n, cap));
    try {
      // In stream mode a character cut at the end is held back instead of rejected.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: truncated });
      return { text, bytes: Buffer.byteLength(text), truncated };
    } catch {
      return { text: null, bytes: 0, truncated: false };
    }
  } finally {
    closeSync(fd);
  }
}

const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

/**
 * The permission rows to show: defers and blocks of the last 24 hours, latest first. For a call the classifier
 * decided, its classifier row stands for the call, so a later answer adds no second row; the caller shows the
 * answer next to the classifier's verdict instead.
 */
function recentlyDecided(decisions: DecisionRecord[], isClassifier: (basis: string) => boolean): DecisionRecord[] {
  const classifier = new Map<string, DecisionRecord>();
  for (const d of decisions) if (isClassifier(d.basis)) classifier.set(d.callId, d);
  return decisions
    .filter((d) => d.decision !== "allow" && (classifier.get(d.callId) ?? d) === d)
    .reverse()
    .slice(0, LATEST);
}

/**
 * One agent's view, read in one transaction, so the counts and totals agree with each other. `serve` is one process
 * for every agent, so its heartbeat is read from the default agent's inbox.
 */
/**
 * What a waiting call asks, unclipped. A bash call reads as its command; the rest of its args follow as JSON. An
 * admit reads as each held event in full, with who sent it, since its args carry only a 200-character preview.
 */
function fullAsk(d: PendingCall, events: Event[]): string {
  if (d.kind === "question") return String((d.args as { question?: unknown }).question);
  if (d.kind === "admit") {
    const ids = new Set((d.args as { events?: string[] }).events ?? []);
    return events
      .filter((e) => ids.has(e.id))
      .map((e) => {
        const payload = e.payload as { from?: unknown; text?: unknown } | null;
        const who = e.source === "agent_message" && typeof payload?.from === "string" ? `agent ${payload.from}` : e.source;
        const text = typeof payload?.text === "string" ? payload.text : JSON.stringify(e.payload, null, 2);
        return `From ${who}${e.thread === null ? "" : ` on ${e.thread}`}:\n${text}`;
      })
      .join("\n\n");
  }
  const args = typeof d.args === "object" && d.args !== null ? (d.args as Record<string, unknown>) : null;
  if (d.tool === "bash" && args && typeof args.command === "string") {
    const { command, ...rest } = args;
    return `$ ${command}${Object.keys(rest).length > 0 ? `\n${JSON.stringify(rest)}` : ""}`;
  }
  return `${d.tool} ${JSON.stringify(d.args, null, 2)}`;
}

export function snapshot(agent: Pick<Agent, "store" | "records" | "inboxId" | "clock" | "paths" | "agents">): Snapshot {
  const { inboxId } = agent;
  const now = agent.clock.now();
  const since = now - DAY_MS;
  const recent = (at: number | null) => at !== null && at >= since;
  const count = (ats: (number | null)[]): Count => ({ total: ats.length, last24h: ats.filter(recent).length });
  const later: number[] = [];

  const files = listFiles(agent.paths.memory);
  const s = agent.store.tx((t: Tx): Snapshot => {
    const beat = agent.store.lastBeat();
    const seen = beat?.seen ?? null;
    if (seen !== null && seen + SERVE_STALE_MS >= now) later.push(seen + SERVE_STALE_MS + 1);
    const serve: Snapshot["serve"] = {
      state: seen === null ? "never" : now - seen > SERVE_STALE_MS ? "offline" : "running",
      startedAt: beat?.since ?? null,
      seenAt: seen,
    };

    const events = t.listEvents(inboxId);
    const rowOf = (e: (typeof events)[number]): InboxRow => {
      const retrying = e.status === "pending" && e.nextAttemptAt > now;
      if (retrying) later.push(e.nextAttemptAt);
      return {
        id: e.id,
        source: e.source,
        thread: e.thread,
        sessionId: e.resume,
        status: retrying ? "retrying" : e.status,
        attempts: e.attempts,
        receivedAt: e.receivedAt,
        nextAttemptAt: retrying ? e.nextAttemptAt : null,
        run: e.run,
        leaseUntil: e.status === "in_run" ? e.leaseUntil : null,
      };
    };
    const inboxRows = events.map(rowOf);
    const eventCounts: Snapshot["events"]["counts"] = { pending: 0, in_run: 0, retrying: 0, dead: 0, done: 0, dropped: 0 };
    for (const r of inboxRows) eventCounts[r.status]++;
    const settled = (r: InboxRow) => r.status === "done" || r.status === "dropped";
    const eventRows = [
      ...inboxRows.filter((r) => !settled(r)).slice(0, OPEN_LIMIT),
      ...inboxRows.filter(settled).slice(-LATEST).reverse(),
    ];

    const runs = t.listRuns(inboxId);
    const held = inboxRows.filter((r) => r.status === "in_run" && r.leaseUntil !== null && r.leaseUntil > now);
    let worker: Snapshot["worker"] = null;
    if (held.length > 0) {
      const runId = held[0]!.run!;
      const run = runs.find((r) => r.id === runId);
      const leaseUntil = Math.max(...held.filter((r) => r.run === runId).map((r) => r.leaseUntil!));
      later.push(leaseUntil);
      worker = {
        runId,
        sessionId: run?.sessionId ?? null,
        startedAt: run?.startedAt ?? null,
        leaseUntil,
        events: held.filter((r) => r.run === runId).length,
      };
    }

    const timers = t.listTimers(inboxId);
    const armed = timers.filter((x) => x.status === "armed");
    const expiresCallOf = (x: (typeof timers)[number]): string | null => {
      const { expiredCall } = (x.payload ?? {}) as { expiredCall?: unknown };
      return typeof expiredCall === "string" ? expiredCall : null;
    };
    const timerRow = (x: (typeof timers)[number]): TimerRow => {
      const { note } = (x.payload ?? {}) as { note?: unknown };
      const expiresCall = expiresCallOf(x);
      return {
        id: x.id,
        kind: x.kind,
        sessionId: x.sessionId,
        thread: x.sessionId === null ? null : t.primaryThread(x.sessionId),
        status: x.status,
        due: x.due,
        everyMs: x.recurrence?.everyMs ?? null,
        lastFired: x.lastFired,
        text:
          typeof note === "string"
            ? note
            : expiresCall !== null
              ? null
              : typeof x.payload === "string"
                ? x.payload
                : JSON.stringify(x.payload, null, 2),
        expiresCall,
      };
    };
    // A cancelled timer records no cancel time and is usually cancelled before it was due, so it cannot be placed
    // among the fired ones; it comes after them. An expiry cancelled because its call was answered is left out.
    const fired = timers.filter((x) => x.status === "done").sort((a, b) => b.lastFired! - a.lastFired!);
    const cancelled = timers.filter((x) => x.status === "cancelled" && expiresCallOf(x) === null).reverse();
    const ended = [...fired, ...cancelled].slice(0, LATEST);
    const nextTimer = armed[0] ? { id: armed[0].id, kind: armed[0].kind, due: armed[0].due } : null;

    const sessions = t.listSessions(inboxId);
    // Both are read per session; "latest" below means latest across all of them.
    const journal: JournalRecord[] = sessions.flatMap((x) => t.listJournal(x.id)).sort((a, b) => a.intentAt - b.intentAt);
    const decisions = sessions.flatMap((x) => t.listDecisions(x.id)).sort((a, b) => a.at - b.at);
    const deferred = t.listDeferred(inboxId);
    // The deferred row lasts until the run that takes the answer has settled the call, approved calls included.
    const queuedAnswer = (callId: string): "approve" | "deny" | null => {
      const e = events.find((x) => x.source === "approval_answer" && (x.status === "pending" || x.status === "in_run") && (x.payload as { callId?: unknown }).callId === callId);
      return e ? (e.payload as { verdict: "approve" | "deny" }).verdict : null;
    };
    const judgments = agent.records.judgments.list(inboxId, now - WEEK_MS);
    const judgmentOf = new Map(judgments.map((j) => [j.callId, j]));
    const jevOf = (callId: string): JevScore | null => {
      const j = judgmentOf.get(callId);
      return j ? { model: j.model, p: j.p, error: j.error, latencyMs: j.latencyMs } : null;
    };
    const classifierVerdict = (basis: string): "allow" | "block" | "unsure" | null => {
      const match = /^(?:reviewer|classifier):(allow|block|unsure)$/.exec(basis);
      return (match?.[1] as "allow" | "block" | "unsure" | undefined) ?? null;
    };
    const verdictOf = new Map<string, "allow" | "block" | "unsure">();
    const userAnswerOf = new Map<string, "approve" | "deny">();
    for (const d of decisions) {
      const verdict = classifierVerdict(d.basis);
      if (verdict !== null) verdictOf.set(d.callId, verdict);
      if (d.basis === "user approved") userAnswerOf.set(d.callId, "approve");
      else if (d.basis === "user denied" || d.basis === "expired") userAnswerOf.set(d.callId, "deny");
    }
    const matrix: ShadowSummary["matrix"] = {
      allow: { high: 0, mid: 0, low: 0 },
      block: { high: 0, mid: 0, low: 0 },
      unsure: { high: 0, mid: 0, low: 0 },
    };
    for (const j of judgments) {
      const verdict = verdictOf.get(j.callId);
      if (verdict === undefined || j.p === null) continue;
      matrix[verdict][j.p >= 0.9 ? "high" : j.p >= 0.5 ? "mid" : "low"]++;
    }
    const shadow: ShadowSummary = {
      judged: judgments.length,
      failed: judgments.filter((j) => j.p === null).length,
      matrix,
    };
    const argsOf = new Map<string, string>();
    for (const j of journal) argsOf.set(j.callId, asks(j.tool, "approval", j.args));
    for (const d of deferred) argsOf.set(d.callId, asks(d.tool, d.kind, d.args));

    const writes = journal.filter((j) => j.tool === "memory_write");
    for (const f of files) f.writtenBy = writes.findLast((j) => memoryPath((j.args as { path?: unknown })?.path) === f.path)?.sessionId ?? null;
    const stateOf = new Map(sessions.map((x) => [x.id, x.status]));
    for (const f of files) {
      const sessionId = PROGRESS_FILE.exec(f.path)?.[1];
      if (sessionId !== undefined) f.task = { sessionId, state: stateOf.get(sessionId) ?? "unknown" };
    }
    // The same read the worker makes for a run's "Already told the user".
    const told = t.listRecentSent(inboxId, RESIDENT_RECENT_MESSAGES).map((m) => ({ id: m.id, thread: m.thread, body: m.body, createdAt: m.createdAt }));
    const today = startOfDay(now);
    const writesToday = new Map<string, number>();
    for (const j of writes) if (j.intentAt >= today) writesToday.set(j.sessionId, (writesToday.get(j.sessionId) ?? 0) + 1);

    const dayDecisions = decisions.filter((d) => recent(d.at));
    const last24h: Record<Decision, number> = { allow: 0, defer: 0, block: 0 };
    const allowsByBasis = new Map<string, number>();
    for (const d of dayDecisions) {
      last24h[d.decision]++;
      if (d.decision === "allow") allowsByBasis.set(d.basis, (allowsByBasis.get(d.basis) ?? 0) + 1);
    }

    const outbox = t.listOutbox(inboxId);
    const waitingIds = new Set(deferred.map((d) => d.callId));
    const outRow = (m: QueuedRow): OutboxRow => ({
      id: m.id,
      kind: m.kind,
      thread: m.thread,
      sessionId: m.sessionId,
      body: m.body,
      status: m.status,
      attempts: m.attempts,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      approval:
        m.kind !== "approval_request"
          ? null
          : m.status === "cancelled"
            ? "cancelled"
            : m.callId !== null && waitingIds.has(m.callId)
              ? "pending"
              : "answered",
    });
    const outCounts: Snapshot["outbox"]["counts"] = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
    for (const m of outbox) outCounts[m.status]++;
    const undelivered = outbox.filter((m) => m.status === "pending" || m.status === "sending" || m.status === "failed");
    const sent = outbox
      .filter((m) => m.status === "sent" || m.status === "cancelled")
      .reverse()
      .sort((a, b) => (b.sentAt ?? b.createdAt) - (a.sentAt ?? a.createdAt))
      .slice(0, LATEST);

    const expired = (e: (typeof events)[number]) => e.source === "approval_answer" && (e.payload as { expired?: true }).expired === true;
    const appended = events.filter((e) => e.status !== "dropped");
    const intents = (match: (tool: string) => boolean) => count(journal.filter((j) => match(j.tool)).map((j) => j.intentAt));

    return {
      at: now,
      inboxId,
      serve,
      worker,
      nextTimer,
      events: { counts: eventCounts, rows: eventRows },
      timers: {
        counts: {
          armed: armed.length,
          schedule: armed.filter((x) => x.kind === "schedule").length,
          done: timers.filter((x) => x.status === "done").length,
          cancelled: timers.filter((x) => x.status === "cancelled").length,
        },
        rows: [...armed, ...ended].map(timerRow),
      },
      memory: {
        root: agent.paths.memory,
        files,
        totalBytes: files.reduce((n, f) => n + f.size, 0),
        writesToday: [...writesToday].map(([sessionId, count]) => ({ sessionId, count })),
        told,
      },
      permissions: {
        waiting: deferred.map((d) => ({
          callId: d.callId,
          sessionId: d.sessionId,
          tool: d.tool,
          args: argsOf.get(d.callId)!,
          basis: decisions.findLast((x) => x.callId === d.callId && x.decision === "defer")?.basis ?? null,
          jev: jevOf(d.callId),
          askedAt: d.requestedAt,
          expiresAt: d.expiresAt,
          answer: `aoa answer ${d.callId} approve|deny`,
          kind: d.kind,
          full: fullAsk(d, events),
          answered: queuedAnswer(d.callId),
        })),
        last24h,
        recent: recentlyDecided(dayDecisions, (basis) => /^(?:reviewer|classifier):/.test(basis))
          .map((d) => ({
            ...d,
            args: argsOf.get(d.callId) ?? null,
            classifier: classifierVerdict(d.basis),
            jev: jevOf(d.callId),
            userAnswer: userAnswerOf.get(d.callId) ?? null,
          })),
        allowsByBasis: [...allowsByBasis].map(([basis, count]) => ({ basis, count })).sort((a, b) => b.count - a.count),
        shadow,
      },
      outbox: { counts: outCounts, rows: [...undelivered, ...sent].map(outRow) },
      edges: {
        in: count(appended.filter((e) => e.source !== "timer" && !expired(e)).map((e) => e.receivedAt)),
        claim: count(runs.map((r) => r.startedAt)),
        calls: intents(() => true),
        set: intents((tool) => tool === "wake_me_at" || tool === "cancel_wake"),
        memory: intents((tool) => tool.startsWith("memory_")),
        says: count(outbox.map((m) => m.createdAt)),
        fires: count(appended.filter((e) => e.source === "timer" || expired(e)).map((e) => e.receivedAt)),
        delivered: count(outbox.flatMap((m) => (m.sentAt === null ? [] : [m.sentAt]))),
      },
      inFromAgents: count(appended.filter((e) => e.source === "agent_message").map((e) => e.receivedAt)),
      nextChangeAt: null,
    };
  });
  s.nextChangeAt = later.length > 0 ? Math.min(...later) : null;
  return s;
}

/** Per edge, how many crossed it between two snapshots; edges nothing crossed are left out. */
export function flows(prev: Snapshot, next: Snapshot): Partial<Record<Edge, number>> {
  const moved: Partial<Record<Edge, number>> = {};
  for (const edge of EDGES) {
    const n = next.edges[edge].total - prev.edges[edge].total;
    if (n > 0) moved[edge] = n;
  }
  return moved;
}

/** Whether two snapshots show anything different; when they were taken does not count. */
export function changed(prev: Snapshot, next: Snapshot): boolean {
  return JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 });
}
