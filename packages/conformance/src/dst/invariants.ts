import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEAD_NOTICE_PREFIX,
  MAX_ATTEMPTS,
  OUTBOX_MAX_ATTEMPTS,
  type CallId,
  type DecisionRecord,
  type Event,
  type EventId,
  type Grant,
  type InboxId,
  type OutboxRow,
  type PendingCall,
  type RunRecord,
  type Session,
  type SessionId,
  type Store,
  type Timer,
  type Tx,
} from "../kernel.ts";
import type { FakeChannel } from "../fake-channel.ts";
import type { FakeClock } from "../fake-clock.ts";

/** Side-effect and concurrency counters observed by the DST tools and runtime. */
export type OracleEffects = {
  nonIdempotentCounts: ReadonlyMap<string, number>;
  idempotentCounts: ReadonlyMap<string, number>;
  kernelExecutions: readonly { sessionId: SessionId; callId: CallId; tool: string; args: unknown; idempotent: boolean }[];
  harnessExecutions: readonly { sessionId: SessionId; callId: CallId; tool: string; args: unknown }[];
  maxActive: number;
  activeSessions: ReadonlySet<SessionId>;
  callbackViolations: readonly string[];
};

/** Monotonic shadow state tracked across oracle checks over the life of a run. */
export type ShadowState = {
  initialInstructions: string;
  eventResume: Map<EventId, SessionId>;
  threadOwner: Map<string, SessionId>;
  taintedSessions: Set<SessionId>;
  consumedEventKeys: Set<string>;
};

/** Inputs required by `checkInvariants` and `checkQuiescence`. */
export type InvariantContext = {
  store: Store;
  inboxId: InboxId;
  clock: FakeClock;
  channel: FakeChannel;
  memoryDir: string;
  effects: OracleEffects;
  shadow: ShadowState;
};

/** Creates a fresh shadow state initialized with the expected `instructions.md` contents. */
export function createShadowState(initialInstructions: string): ShadowState {
  return {
    initialInstructions,
    eventResume: new Map(),
    threadOwner: new Map(),
    taintedSessions: new Set(),
    consumedEventKeys: new Set(),
  };
}

function fail(invariantId: string, message: string): never {
  throw new Error(`[${invariantId}] ${message}`);
}

function assertInvariant(condition: boolean, invariantId: string, message: string): asserts condition {
  if (!condition) fail(invariantId, message);
}

function checkSingleActiveWorker(events: readonly Event[], effects: OracleEffects): void {
  const id = "I-EVT-1/C1";
  assertInvariant(
    effects.callbackViolations.length === 0,
    id,
    `callback violations recorded: ${effects.callbackViolations.join("; ")}`,
  );
  assertInvariant(effects.maxActive <= 1, id, `maxActive must be <= 1, got ${effects.maxActive}`);

  const inRun = events.filter((e) => e.status === "in_run");
  const activeRuns = new Set(inRun.map((e) => e.run));
  assertInvariant(activeRuns.size <= 1, id, `multiple runs hold in_run events simultaneously: ${activeRuns.size}`);

  for (const e of events) {
    assertInvariant(
      (e.status === "in_run") === (e.leaseUntil !== null),
      id,
      `event ${e.id} has status=${e.status} and leaseUntil=${String(e.leaseUntil)}`,
    );
    if (e.status === "in_run") {
      assertInvariant(e.run !== null, id, `in_run event ${e.id} has null run`);
    }
  }
}

function checkEventDedupe(events: readonly Event[]): void {
  const id = "I-EVT-4/C4";
  const seen = new Set<string>();
  for (const e of events) {
    if (e.status === "dropped") continue;
    const key = JSON.stringify([e.source, e.dedupeKey]);
    assertInvariant(!seen.has(key), id, `duplicate non-dropped event for (${e.source}, ${e.dedupeKey})`);
    seen.add(key);
  }
}

function checkSessionAffinity(
  t: Tx,
  inboxId: InboxId,
  events: readonly Event[],
  sessions: readonly Session[],
  shadow: ShadowState,
): void {
  const id = "I-EVT-7";
  for (const e of events) {
    const prev = shadow.eventResume.get(e.id);
    if (prev !== undefined) {
      assertInvariant(e.resume === prev, id, `event ${e.id} resume changed from ${prev} to ${String(e.resume)}`);
    } else if (e.resume !== null) {
      shadow.eventResume.set(e.id, e.resume);
    }
  }

  for (const s of sessions) {
    for (const th of t.listThreads(s.id)) {
      const owner = t.sessionForThread(inboxId, th);
      assertInvariant(owner === s.id, id, `thread ${th} on session ${s.id} resolves to ${String(owner)}`);
      const prevOwner = shadow.threadOwner.get(th);
      if (prevOwner !== undefined) {
        assertInvariant(prevOwner === s.id, id, `thread ${th} changed owner from ${prevOwner} to ${s.id}`);
      } else {
        shadow.threadOwner.set(th, s.id);
      }
    }
  }
}

function checkDeadLetters(events: readonly Event[], outbox: readonly OutboxRow[]): void {
  const id = "I-EVT-2/dead-letter";
  for (const e of events) {
    if (e.status !== "dead") continue;
    assertInvariant(
      e.attempts >= MAX_ATTEMPTS,
      id,
      `dead event ${e.id} has attempts=${e.attempts} < MAX_ATTEMPTS (${MAX_ATTEMPTS})`,
    );
    if (e.resume !== null) {
      const prefix = `${DEAD_NOTICE_PREFIX}${e.resume}:`;
      assertInvariant(
        outbox.some((m) => m.dedupeKey.startsWith(prefix)),
        id,
        `dead event ${e.id} for session ${e.resume} lacks dead-letter notice (${prefix}*)`,
      );
    }
  }
}

function checkRuns(events: readonly Event[], runs: readonly RunRecord[]): void {
  const id = "I-EVT-6/I-OUT-1/C18";
  const eventById = new Map(events.map((e) => [e.id, e]));
  for (const r of runs) {
    if (r.error !== null) {
      assertInvariant(
        r.endedAt !== null && r.end === null,
        id,
        `errored run ${r.id} has endedAt=${String(r.endedAt)}, end=${JSON.stringify(r.end)}`,
      );
      continue;
    }
    if (r.endedAt === null) {
      assertInvariant(r.end === null, id, `unfinished run ${r.id} has non-null end`);
      continue;
    }
    assertInvariant(r.end !== null, id, `completed run ${r.id} has null end`);
    if (r.end.kind === "sent") {
      assertInvariant(r.end.msgs.length > 0, id, `run ${r.id} ended with sent but empty msgs`);
    }
    assertInvariant(r.events.length > 0, id, `completed run ${r.id} has empty events`);
    for (const eventId of r.events) {
      const ev = eventById.get(eventId);
      assertInvariant(ev !== undefined, id, `run ${r.id} references missing event ${eventId}`);
      assertInvariant(ev.status === "done", id, `completed run ${r.id} event ${eventId} has status=${ev.status}`);
      assertInvariant(
        ev.resume === r.sessionId,
        id,
        `completed run ${r.id} event ${eventId} has resume=${String(ev.resume)}, expected ${r.sessionId}`,
      );
    }
  }
}

function checkDeferralsAndSessions(
  events: readonly Event[],
  sessions: readonly Session[],
  deferred: readonly PendingCall[],
  runs: readonly RunRecord[],
  timers: readonly Timer[],
  effects: OracleEffects,
  shadow: ShadowState,
): void {
  const id = "I-PRM-4/I-SYS-7/Deferrals";
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const sessionsWithArmedTimer = new Set<SessionId>();
  for (const tm of timers) {
    if (tm.status === "armed" && tm.sessionId !== null) sessionsWithArmedTimer.add(tm.sessionId);
  }

  for (const s of sessions) {
    assertInvariant(
      (s.status === "paused") === (s.pending !== null),
      id,
      `session ${s.id} has status=${s.status} and pending=${String(s.pending)}`,
    );
    if (s.status === "closed") {
      assertInvariant(s.pending === null, id, `closed session ${s.id} has non-null pending=${String(s.pending)}`);
      assertInvariant(!sessionsWithArmedTimer.has(s.id), id, `closed session ${s.id} still has armed timers`);
    }
    if (shadow.taintedSessions.has(s.id)) {
      assertInvariant(s.tainted, id, `session ${s.id} reverted tainted from true to false`);
    }
    if (s.tainted) shadow.taintedSessions.add(s.id);
  }

  const deferredByCallId = new Map<CallId, PendingCall>();
  const deferredBySessionId = new Map<SessionId, PendingCall>();
  for (const d of deferred) {
    assertInvariant(!deferredByCallId.has(d.callId), id, `duplicate deferred callId ${d.callId}`);
    assertInvariant(!deferredBySessionId.has(d.sessionId), id, `session ${d.sessionId} has multiple deferred rows`);
    deferredByCallId.set(d.callId, d);
    deferredBySessionId.set(d.sessionId, d);
    const s = sessionById.get(d.sessionId);
    assertInvariant(
      s !== undefined && s.pending === d.callId,
      id,
      `deferred call ${d.callId} points to session ${d.sessionId} with pending=${String(s?.pending)}`,
    );
  }

  const pausedSessions = sessions.filter((s) => s.pending !== null);
  assertInvariant(
    pausedSessions.length === deferred.length,
    id,
    `paused sessions (${pausedSessions.length}) != deferred rows (${deferred.length})`,
  );
  for (const s of pausedSessions) {
    const d = deferredByCallId.get(s.pending!);
    assertInvariant(
      d !== undefined && d.sessionId === s.id,
      id,
      `paused session ${s.id} pending=${s.pending} has no matching deferred row`,
    );
  }

  if (effects.activeSessions.size !== 0) return;

  const runById = new Map(runs.map((r) => [r.id, r]));
  for (const s of pausedSessions) {
    const inRunForSession = events.filter((e) => e.status === "in_run" && e.resume === s.id);
    if (inRunForSession.length === 0) continue;

    // A before_complete crash inside the run that called deferInTx leaves s paused with the run's
    // triggering events still in_run; only require an approval_answer if s was paused beforehand.
    const d = deferredByCallId.get(s.pending!)!;
    const crashedRunId = inRunForSession[0]!.run;
    const crashedRun = crashedRunId === null ? undefined : runById.get(crashedRunId);
    const alreadyPausedBeforeCrashedRun =
      d.kind === "admit" ||
      runs.some((prev) => prev.end?.kind === "deferred" && prev.end.callId === s.pending) ||
      crashedRun === undefined ||
      d.requestedAt < crashedRun.startedAt;
    if (!alreadyPausedBeforeCrashedRun) continue;

    const hasMatchingAnswer = inRunForSession.some(
      (e) => e.source === "approval_answer" && (e.payload as { callId?: unknown } | null)?.callId === s.pending,
    );
    assertInvariant(
      hasMatchingAnswer,
      id,
      `paused session ${s.id} (pending=${s.pending}) has in_run events without matching approval_answer`,
    );
  }
}

function checkAnswersAndRequests(events: readonly Event[], outbox: readonly OutboxRow[]): void {
  const answerCallIds = new Set<string>();
  for (const e of events) {
    if (e.source !== "approval_answer" || e.status === "dropped") continue;
    const callId = (e.payload as { callId?: unknown } | null)?.callId;
    assertInvariant(typeof callId === "string", "I-PRM-5/C16", `approval_answer event ${e.id} has invalid callId`);
    assertInvariant(!answerCallIds.has(callId), "I-PRM-5/C16", `multiple non-dropped approval_answer events for ${callId}`);
    answerCallIds.add(callId);
  }

  const requestCallIds = new Set<CallId>();
  for (const m of outbox) {
    if (m.kind !== "approval_request") continue;
    assertInvariant(m.callId !== null, "I-OUT-5/C20", `approval_request outbox row ${m.id} has null callId`);
    assertInvariant(!requestCallIds.has(m.callId), "I-OUT-5/C20", `multiple approval_request rows for ${m.callId}`);
    requestCallIds.add(m.callId);
  }
}

function checkExecutionsAndPermissions(t: Tx, sessions: readonly Session[], effects: OracleEffects): void {
  for (const [key, count] of effects.nonIdempotentCounts) {
    assertInvariant(count <= 1, "I-EVT-3/C3", `non-idempotent execution ${key} ran ${count} times`);
  }

  const decisionsBySession = new Map<SessionId, DecisionRecord[]>();
  const getDecisions = (sessionId: SessionId): DecisionRecord[] => {
    let list = decisionsBySession.get(sessionId);
    if (!list) {
      list = t.listDecisions(sessionId);
      decisionsBySession.set(sessionId, list);
    }
    return list;
  };

  const grantsBySession = new Map<SessionId, Grant[]>();
  const getGrants = (sessionId: SessionId): Grant[] => {
    let list = grantsBySession.get(sessionId);
    if (!list) {
      list = t.listGrants(sessionId);
      grantsBySession.set(sessionId, list);
    }
    return list;
  };

  for (const exec of effects.kernelExecutions) {
    const allowed = getDecisions(exec.sessionId).some((d) => d.callId === exec.callId && d.decision === "allow");
    assertInvariant(
      allowed,
      "I-PRM-2/C14",
      `kernel execution ${exec.tool} (${exec.callId}) in session ${exec.sessionId} lacks allow decision`,
    );
    assertInvariant(
      t.getJournal(exec.sessionId, exec.callId) !== null,
      "I-PRM-2/C14",
      `kernel execution ${exec.tool} (${exec.callId}) in session ${exec.sessionId} lacks journal entry`,
    );
  }

  for (const exec of effects.harnessExecutions) {
    const allowed = getDecisions(exec.sessionId).some(
      (d) => d.callId === exec.callId && d.tool === exec.tool && d.decision === "allow",
    );
    assertInvariant(
      allowed,
      "I-PRM-2/C14",
      `harness execution ${exec.tool} (${exec.callId}) in session ${exec.sessionId} lacks allow decision`,
    );
    const hasGrant = getGrants(exec.sessionId).some((g) => g.usedBy === exec.callId && g.tool === exec.tool);
    assertInvariant(
      hasGrant,
      "I-PRM-2/C14",
      `harness execution ${exec.tool} (${exec.callId}) in session ${exec.sessionId} lacks matching used grant`,
    );
  }

  for (const s of sessions) {
    const usedBySet = new Set<CallId>();
    for (const g of getGrants(s.id)) {
      if (g.usedBy === null) continue;
      assertInvariant(
        !usedBySet.has(g.usedBy),
        "I-PRM-2/C14",
        `session ${s.id} grant usedBy=${g.usedBy} appears on multiple grants`,
      );
      usedBySet.add(g.usedBy);
    }
  }
}

function checkTimers(events: readonly Event[], timers: readonly Timer[], now: number): void {
  const id = "I-TMR-1/I-TMR-3/I-TMR-5/C7/C8/C9";
  const nonDroppedTimerKeys = new Set<string>();
  const allTimerKeys = new Set<string>();

  for (const e of events) {
    if (e.source !== "timer") continue;
    allTimerKeys.add(e.dedupeKey);
    if (e.status === "dropped") continue;
    assertInvariant(!nonDroppedTimerKeys.has(e.dedupeKey), id, `duplicate non-dropped timer event key ${e.dedupeKey}`);
    nonDroppedTimerKeys.add(e.dedupeKey);
  }

  for (const tm of timers) {
    assertInvariant(
      (tm.kind === "schedule") === (tm.recurrence !== null),
      id,
      `timer ${tm.id} has kind=${tm.kind} with recurrence=${JSON.stringify(tm.recurrence)}`,
    );
    if (tm.kind === "follow_up" && tm.lastFired !== null) {
      assertInvariant(tm.status === "done", id, `fired follow_up timer ${tm.id} has status=${tm.status}`);
    }
    if (tm.kind === "schedule") {
      assertInvariant(
        tm.recurrence !== null && (tm.due - tm.recurrence.anchor) % tm.recurrence.everyMs === 0,
        id,
        `schedule timer ${tm.id} drifted: due=${tm.due}, anchor=${tm.recurrence?.anchor}, everyMs=${tm.recurrence?.everyMs}`,
      );
    }
    if (tm.status === "armed" && tm.due > now) {
      const futureKey = `${tm.id}:${tm.due}`;
      assertInvariant(!allTimerKeys.has(futureKey), id, `future armed timer ${tm.id} already has event ${futureKey}`);
    }
  }
}

function checkOutboxAndChannel(outbox: readonly OutboxRow[], channel: FakeChannel): void {
  const id = "I-OUT-2/P-OUT-3/C17";
  const outboxById = new Map(outbox.map((row) => [row.id, row]));
  const visibleDedupeKeys = new Set<string>();
  const lastSeqBySession = new Map<SessionId, number>();

  for (const m of channel.visible) {
    assertInvariant(!visibleDedupeKeys.has(m.dedupeKey), id, `duplicate dedupeKey in channel.visible: ${m.dedupeKey}`);
    visibleDedupeKeys.add(m.dedupeKey);

    const row = outboxById.get(m.id);
    assertInvariant(
      row !== undefined && row.dedupeKey === m.dedupeKey,
      id,
      `visible message ${m.id} (${m.dedupeKey}) missing from outbox`,
    );

    const prevSeq = lastSeqBySession.get(row.sessionId);
    if (prevSeq !== undefined) {
      assertInvariant(
        row.seq > prevSeq,
        id,
        `session ${row.sessionId} delivered out of FIFO order: seq ${row.seq} after ${prevSeq}`,
      );
    }
    lastSeqBySession.set(row.sessionId, row.seq);
  }

  for (const row of outbox) {
    if (row.status === "sent") {
      assertInvariant(row.sentAt !== null, id, `sent outbox row ${row.id} has null sentAt`);
      assertInvariant(
        visibleDedupeKeys.has(row.dedupeKey),
        id,
        `sent outbox row ${row.id} (${row.dedupeKey}) missing from channel.visible`,
      );
    }
    if (row.status === "failed") {
      assertInvariant(
        row.attempts === OUTBOX_MAX_ATTEMPTS,
        id,
        `failed outbox row ${row.id} has attempts=${row.attempts}, expected ${OUTBOX_MAX_ATTEMPTS}`,
      );
    }
  }
}

function checkMemoryInstructions(memoryDir: string, expected: string): void {
  const id = "C10/Memory";
  let actual: string;
  try {
    actual = readFileSync(join(memoryDir, "instructions.md"), "utf8");
  } catch (err) {
    fail(id, `failed to read instructions.md: ${err instanceof Error ? err.message : String(err)}`);
  }
  assertInvariant(actual === expected, id, "instructions.md contents differ from initialInstructions");
}

/** Verifies all kernel safety invariants against the persistent store, channel, memory, and shadow state. */
export function checkInvariants(ctx: InvariantContext): void {
  const { store, inboxId, clock, channel, memoryDir, effects, shadow } = ctx;
  const now = clock.now();

  store.tx((t) => {
    const events = t.listEvents(inboxId);
    const sessions = t.listSessions(inboxId);
    const outbox = t.listOutbox(inboxId);
    const runs = t.listRuns(inboxId);
    const deferred = t.listDeferred(inboxId);
    const timers = t.listTimers(inboxId);

    checkSingleActiveWorker(events, effects);
    checkEventDedupe(events);
    checkSessionAffinity(t, inboxId, events, sessions, shadow);
    checkDeadLetters(events, outbox);
    checkRuns(events, runs);
    checkDeferralsAndSessions(events, sessions, deferred, runs, timers, effects, shadow);
    checkAnswersAndRequests(events, outbox);
    checkExecutionsAndPermissions(t, sessions, effects);
    checkTimers(events, timers, now);
    checkOutboxAndChannel(outbox, channel);
  });

  checkMemoryInstructions(memoryDir, shadow.initialInstructions);
}

/** Verifies all invariants plus terminal quiescence conditions once draining completes. */
export function checkQuiescence(ctx: InvariantContext): void {
  checkInvariants(ctx);

  assertInvariant(
    ctx.effects.activeSessions.size === 0,
    "I-EVT-1/Quiescence",
    `expected 0 active sessions at quiescence, got ${ctx.effects.activeSessions.size}`,
  );

  ctx.store.tx((t) => {
    const events = t.listEvents(ctx.inboxId);
    const runs = t.listRuns(ctx.inboxId);
    const deferred = t.listDeferred(ctx.inboxId);
    const sessions = t.listSessions(ctx.inboxId);
    const outbox = t.listOutbox(ctx.inboxId);
    const timers = t.listTimers(ctx.inboxId);

    const completedRunEvents = new Set<EventId>();
    for (const r of runs) {
      if (r.endedAt !== null && r.error === null) {
        for (const eid of r.events) completedRunEvents.add(eid);
      }
    }

    for (const e of events) {
      assertInvariant(
        e.status === "done" || e.status === "dropped" || e.status === "dead",
        "I-EVT-2/Quiescence",
        `event ${e.id} has non-terminal status=${e.status} at quiescence`,
      );
      if (e.status === "done") {
        assertInvariant(
          completedRunEvents.has(e.id),
          "I-EVT-6/Quiescence",
          `done event ${e.id} is not recorded in any completed RunRecord`,
        );
      }
    }

    assertInvariant(
      deferred.length === 0,
      "I-SYS-7/Quiescence",
      `expected empty deferred list at quiescence, got ${deferred.length}`,
    );
    for (const s of sessions) {
      assertInvariant(s.status !== "paused", "I-SYS-7/Quiescence", `session ${s.id} remains paused at quiescence`);
    }

    for (const m of outbox) {
      assertInvariant(
        m.status === "sent" || m.status === "failed" || m.status === "cancelled",
        "I-OUT-4/Quiescence",
        `outbox row ${m.id} has non-terminal status=${m.status} at quiescence`,
      );
    }

    for (const tm of timers) {
      assertInvariant(
        !(tm.kind === "follow_up" && tm.status === "armed"),
        "I-TMR-3/Quiescence",
        `follow_up timer ${tm.id} remains armed at quiescence`,
      );
    }
  });
}
