import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Decision, EventSource, EventStatus, JournalRecord, OutMsg, Tx } from "@aoa/kernel";
import { SERVE_SEEN, SERVE_STARTED } from "./serve.ts";
import { asks } from "./status.ts";
import type { Agent } from "./wiring.ts";

/** A heartbeat older than this means `serve` is not running: three missed nudges. */
export const SERVE_STALE_MS = 15_000;

const DAY_MS = 24 * 60 * 60_000;
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
  sessionId: string | null;
  status: "armed" | "done" | "cancelled";
  due: number;
  everyMs: number | null;
  lastFired: number | null;
  note: string | null;
  /** For the timer that expires a deferred call: that call. */
  expiresCall: string | null;
};

export type MemoryFile = { path: string; size: number; mtime: number; writtenBy: string | null };

export type WaitingCall = {
  callId: string;
  sessionId: string;
  tool: string;
  args: string;
  basis: string | null;
  askedAt: number;
  expiresAt: number;
  answer: string;
};

export type DecisionRow = { callId: string; sessionId: string; tool: string; args: string | null; decision: Decision; basis: string; at: number };

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
  memory: { root: string; files: MemoryFile[]; totalBytes: number; writesToday: { sessionId: string; count: number }[] };
  permissions: {
    waiting: WaitingCall[];
    last24h: Record<Decision, number>;
    /** Defers and blocks of the last 24 hours, latest first. */
    recent: DecisionRow[];
    allowsByBasis: { basis: string; count: number }[];
  };
  outbox: { counts: Record<OutMsg["status"], number>; rows: OutboxRow[] };
  edges: Record<Edge, Count>;
  /** The next moment the snapshot changes with no write: serve going stale, a retry delay or a lease running out. */
  nextChangeAt: number | null;
};

const memoryPath = (path: unknown): string | null =>
  typeof path === "string" ? path.split(/[\\/]+/).filter((p) => p !== "" && p !== ".").join("/") : null;

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
        files.push({ path: relative(root, full).split(sep).join("/"), size: st.size, mtime: st.mtimeMs, writtenBy: null });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => b.mtime - a.mtime);
}

const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

/** Reads everything in one transaction, so the counts and totals agree with each other. */
export function snapshot(agent: Pick<Agent, "store" | "inboxId" | "clock" | "paths">): Snapshot {
  const { inboxId } = agent;
  const now = agent.clock.now();
  const since = now - DAY_MS;
  const recent = (at: number | null) => at !== null && at >= since;
  const count = (ats: (number | null)[]): Count => ({ total: ats.length, last24h: ats.filter(recent).length });
  const later: number[] = [];

  const files = listFiles(agent.paths.memory);
  const s = agent.store.tx((t: Tx): Snapshot => {
    const seenAt = Number(t.getCursor(inboxId, SERVE_SEEN) ?? NaN);
    const startedAt = Number(t.getCursor(inboxId, SERVE_STARTED) ?? NaN);
    const seen = Number.isFinite(seenAt) ? seenAt : null;
    if (seen !== null && seen + SERVE_STALE_MS >= now) later.push(seen + SERVE_STALE_MS + 1);
    const serve: Snapshot["serve"] = {
      state: seen === null ? "never" : now - seen > SERVE_STALE_MS ? "offline" : "running",
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
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
    const timerRow = (x: (typeof timers)[number]): TimerRow => {
      const { note, expiredCall } = (x.payload ?? {}) as { note?: unknown; expiredCall?: unknown };
      return {
        id: x.id,
        kind: x.kind,
        sessionId: x.sessionId,
        status: x.status,
        due: x.due,
        everyMs: x.recurrence?.everyMs ?? null,
        lastFired: x.lastFired,
        note: typeof note === "string" ? note : null,
        expiresCall: typeof expiredCall === "string" ? expiredCall : null,
      };
    };
    const fired = timers
      .filter((x) => x.lastFired !== null)
      .sort((a, b) => b.lastFired! - a.lastFired!)
      .slice(0, LATEST);
    const nextTimer = armed[0] ? { id: armed[0].id, kind: armed[0].kind, due: armed[0].due } : null;

    const sessions = t.listSessions(inboxId);
    // Both are read per session; "latest" below means latest across all of them.
    const journal: JournalRecord[] = sessions.flatMap((x) => t.listJournal(x.id)).sort((a, b) => a.intentAt - b.intentAt);
    const decisions = sessions.flatMap((x) => t.listDecisions(x.id)).sort((a, b) => a.at - b.at);
    const deferred = t.listDeferred(inboxId);
    const argsOf = new Map<string, string>();
    for (const j of journal) argsOf.set(j.callId, asks(j.tool, "approval", j.args));
    for (const d of deferred) argsOf.set(d.callId, asks(d.tool, d.kind, d.args));

    const writes = journal.filter((j) => j.tool === "memory_write");
    for (const f of files) f.writtenBy = writes.findLast((j) => memoryPath((j.args as { path?: unknown })?.path) === f.path)?.sessionId ?? null;
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
    const sentAt = agent.store.sentTimes(inboxId);
    const waitingIds = new Set(deferred.map((d) => d.callId));
    const outRow = (m: OutMsg): OutboxRow => ({
      id: m.id,
      kind: m.kind,
      thread: m.thread,
      sessionId: m.sessionId,
      body: m.body,
      status: m.status,
      attempts: m.attempts,
      createdAt: m.createdAt,
      sentAt: sentAt.get(m.id) ?? null,
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
      .sort((a, b) => (sentAt.get(b.id) ?? b.createdAt) - (sentAt.get(a.id) ?? a.createdAt))
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
        rows: [...armed, ...fired.filter((x) => x.status !== "armed")].map(timerRow),
      },
      memory: {
        root: agent.paths.memory,
        files,
        totalBytes: files.reduce((n, f) => n + f.size, 0),
        writesToday: [...writesToday].map(([sessionId, count]) => ({ sessionId, count })),
      },
      permissions: {
        waiting: deferred.map((d) => ({
          callId: d.callId,
          sessionId: d.sessionId,
          tool: d.tool,
          args: argsOf.get(d.callId)!,
          basis: decisions.findLast((x) => x.callId === d.callId && x.decision === "defer")?.basis ?? null,
          askedAt: d.requestedAt,
          expiresAt: d.expiresAt,
          answer: `aoa answer ${d.callId} approve|deny`,
        })),
        last24h,
        recent: dayDecisions
          .filter((d) => d.decision !== "allow")
          .reverse()
          .slice(0, LATEST)
          .map((d) => ({ ...d, args: argsOf.get(d.callId) ?? null })),
        allowsByBasis: [...allowsByBasis].map(([basis, count]) => ({ basis, count })).sort((a, b) => b.count - a.count),
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
        delivered: count([...sentAt.values()]),
      },
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
