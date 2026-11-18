import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ChannelPoller,
  DEFAULT_RATE_POLICY,
  DEFER_TTL_MS,
  Dispatcher,
  LEASE_MS,
  LEASE_RENEW_MS,
  POLL_INTERVAL_MS,
  Scheduler,
  SimulatedCrash,
  addFollowUp,
  addSchedule,
  answerDeferred,
  appendEvent,
  askUserTools,
  closeSession,
  dirMemory,
  followTools,
  memoryTools,
  outboxTools,
  pace,
  putSchedule,
  timerTools,
  type CallId,
  type Channel,
  type CrashPoint,
  type EventId,
  type EventSource,
  type EventStatus,
  type InboxId,
  type Memory,
  type MsgKind,
  type NewEvent,
  type PendingCall,
  type PolicyConfig,
  type QueuedMsg,
  type RatePolicy,
  type RunActivity,
  type RunId,
  type RunOutcome,
  type Session,
  type SessionId,
  type Store,
  type TimerId,
  type ToolDef,
  type Tx,
} from "@aoa/kernel";
import { FakeChannel, type DeliveryFailure } from "../fake-channel.ts";
import { Harness, crashAt, sqliteFactory, type StoreFactory } from "../harness.ts";
import { checkInvariants, checkQuiescence, createShadowState, type InvariantContext } from "./invariants.ts";
import { Prng, hashSeed } from "./prng.ts";
import { DstRuntime, createDstTools, createEffectLog, type EffectLog } from "./runtime.ts";

const INITIAL_INSTRUCTIONS = "Never leak secrets; stay concise.";
const UNPACED_POLICY: RatePolicy = { maxMsgs: Number.MAX_SAFE_INTEGER, windowMs: 1, minIntervalMs: 0 };

export type SimConfig = {
  seed: number;
  steps: number;
  mode: "kernel" | "harness";
  storeFactory?: StoreFactory;
  faultProfile?: "standard" | "chaos";
  debounceMs?: number;
  ratePolicy?: RatePolicy;
};

export type FaultStats = {
  after_append: number;
  after_claim: number;
  after_tool_exec: number;
  after_tool_result: number;
  before_complete: number;
  after_timer_fire: number;
  after_deliver: number;
  after_poll: number;
  runtimeFailures: number;
  stopAborts: number;
  competingDrains: number;
  leaseExpirations: number;
  leaseRenewals: number;
  channelBeforeAccept: number;
  channelAfterAccept: number;
  heldDeliveries: number;
  deadEvents: number;
  deferredCreated: number;
  deferredApproved: number;
  deferredDenied: number;
  deferredExpired: number;
  admitHeld: number;
  sessionsClosed: number;
  restarts: number;
};

export type SimResult = {
  seed: number;
  steps: number;
  trace: string[];
  stats: FaultStats;
  finalEvents: { source: EventSource; dedupeKey: string; status: EventStatus }[];
  visibleMessages: { kind: MsgKind; dedupeKey: string; body: string }[];
  harnessExecutions: number;
};

type ScheduledSpec = {
  id: TimerId;
  everyMs: number;
  anchor: number;
  payload: unknown;
  sessionId?: SessionId;
};

type AcceptedSpec = {
  source: EventSource;
  dedupeKey: string;
  payload: unknown;
  thread?: string;
  trusted: boolean;
};

function emptyStats(): FaultStats {
  return {
    after_append: 0,
    after_claim: 0,
    after_tool_exec: 0,
    after_tool_result: 0,
    before_complete: 0,
    after_timer_fire: 0,
    after_deliver: 0,
    after_poll: 0,
    runtimeFailures: 0,
    stopAborts: 0,
    competingDrains: 0,
    leaseExpirations: 0,
    leaseRenewals: 0,
    channelBeforeAccept: 0,
    channelAfterAccept: 0,
    heldDeliveries: 0,
    deadEvents: 0,
    deferredCreated: 0,
    deferredApproved: 0,
    deferredDenied: 0,
    deferredExpired: 0,
    admitHeld: 0,
    sessionsClosed: 0,
    restarts: 0,
  };
}

function recordCrashStat(stats: FaultStats, point: CrashPoint): void {
  stats[point]++;
}

function nextDeterministicUuid(prng: Prng): `${string}-${string}-${string}-${string}-${string}` {
  const a = prng.u32();
  const b = prng.u32();
  const c = prng.u32();
  const d = prng.u32();
  const hex = (n: number, width: number) => (n >>> 0).toString(16).padStart(width, "0");
  const p1 = hex(a, 8);
  const p2 = hex(b >>> 16, 4);
  const p3 = `4${hex(b & 0x0fff, 3)}`;
  const variant = ((c >>> 30) & 0x3) | 0x8;
  const p4 = `${variant.toString(16)}${hex((c >>> 16) & 0x0fff, 3)}`;
  const p5 = `${hex(c & 0xffff, 4)}${hex(d, 8)}`;
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

async function withDeterministicUuid<T>(prng: Prng, fn: () => Promise<T>): Promise<T> {
  const target = crypto as unknown as {
    randomUUID?: () => `${string}-${string}-${string}-${string}-${string}`;
  };
  const hasOwn = Object.prototype.hasOwnProperty.call(crypto, "randomUUID");
  const prev = target.randomUUID;
  target.randomUUID = () => nextDeterministicUuid(prng);
  try {
    return await fn();
  } finally {
    if (hasOwn && prev) {
      target.randomUUID = prev;
    } else {
      delete target.randomUUID;
    }
  }
}

function wrapDstError(
  err: unknown,
  info: { seed: number; mode: "kernel" | "harness"; step: number | string; trace: readonly string[] },
): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const tail = info.trace.slice(-25).join("\n  ");
  const wrapped = new Error(
    `DST failure (seed=${info.seed}, mode=${info.mode}, step=${info.step}): ${msg}\n` +
      `Repro: AOA_DST_SEED=${info.seed} bun test packages/conformance/test/dst.test.ts\n` +
      `Recent trace:\n  ${tail}`,
  );
  if (err instanceof Error && err.stack) {
    wrapped.stack = `${wrapped.message}\n${err.stack}`;
  }
  return wrapped;
}

function createDstPolicy(seed: number): PolicyConfig {
  return {
    rules: [
      {
        name: "allow-readonly-untainted",
        match(call, ctx) {
          if (!ctx.tainted && (call.tool === "memory_read" || call.tool === "memory_list")) {
            return "allow";
          }
          return null;
        },
      },
      {
        name: "block-secret-marker",
        match(call) {
          if (JSON.stringify(call.args ?? null).includes("SECRET")) return "block";
          return null;
        },
      },
      {
        name: "tainted-rule-defer",
        match(call, ctx) {
          if (ctx.tainted && call.tool === "effect_low") {
            const h = hashSeed(`${seed}:${JSON.stringify(call.args ?? null)}`);
            if (h % 3 === 0) return "defer";
          }
          return null;
        },
      },
    ],
    async classify(call, ctx) {
      // Exercise PolicyReader contract without results (spec §6.2).
      if (ctx.read && ctx.call) {
        ctx.read.calls(ctx.call.sessionId);
        ctx.read.events({ limit: 4 });
      }
      const key = `${seed}:${call.tool}:${JSON.stringify(call.args ?? null)}:${ctx.tainted ? 1 : 0}`;
      const bucket = hashSeed(key) % 10;
      if (ctx.tainted) {
        if (bucket < 2) throw new Error("classifier unavailable for tainted session");
        if (bucket < 5) return "block";
        return "unsure";
      }
      if (bucket === 0) throw new Error("classifier transient error");
      if (bucket < 3) return "block";
      if (bucket < 6) return "unsure";
      return "allow";
    },
  };
}

function makeGate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

type SlowToolController = {
  armed: boolean;
  started: boolean;
  onStarted: (() => void) | null;
};

type ActivityMonitor = {
  endedRuns: Set<RunId>;
  inFlightTools: Set<CallId>;
  onRunStart: (run: { runId: RunId; sessionId: SessionId; events: number }) => void;
  onRunEnd: (outcome: RunOutcome) => void;
  onActivity: (a: RunActivity, run: { runId: RunId; sessionId: SessionId }) => void;
};

function createActivityMonitor(
  effects: EffectLog,
  stats: FaultStats,
  onRunEndHook?: (outcome: RunOutcome) => void,
): ActivityMonitor {
  const endedRuns = new Set<RunId>();
  const inFlightTools = new Set<CallId>();
  let activitySeq = 0;

  return {
    endedRuns,
    inFlightTools,
    onRunStart() {},
    onRunEnd(outcome) {
      endedRuns.add(outcome.runId);
      inFlightTools.clear();
      if (outcome.error === "simulated model failure") {
        stats.runtimeFailures++;
      } else if (outcome.error?.startsWith("stopped:")) {
        stats.stopAborts++;
      }
      onRunEndHook?.(outcome);
    },
    onActivity(a, run) {
      if (endedRuns.has(run.runId)) {
        effects.callbackViolations.push(`activity ${a.kind} arrived after onRunEnd for run ${run.runId}`);
      }
      if (a.kind === "tool_start") {
        inFlightTools.add(a.callId);
      } else if (a.kind === "tool_end") {
        inFlightTools.delete(a.callId);
      }
      // Periodically throw to verify the worker isolates subscriber errors safely.
      activitySeq++;
      if (activitySeq % 11 === 0) {
        throw new Error("simulated activity subscriber error");
      }
    },
  };
}

function syncStoreStats(
  store: Store,
  inboxId: InboxId,
  stats: FaultStats,
  seenDead: Set<EventId>,
  seenDeferred: Set<CallId>,
  seenResolutions: Set<string>,
): void {
  store.tx((t) => {
    for (const e of t.listEvents(inboxId)) {
      if (e.status === "dead" && !seenDead.has(e.id)) {
        seenDead.add(e.id);
        stats.deadEvents++;
      }
    }
    for (const d of t.listDeferred(inboxId)) {
      if (!seenDeferred.has(d.callId)) {
        seenDeferred.add(d.callId);
        stats.deferredCreated++;
        if (d.kind === "admit") {
          stats.admitHeld++;
        }
      }
    }
    for (const s of t.listSessions(inboxId)) {
      for (const dec of t.listDecisions(s.id)) {
        const isApprove = dec.basis === "user approved" || dec.basis === "user answered";
        const isDeny = dec.basis === "user denied" || dec.basis === "user declined";
        const isExpired = dec.basis === "expired";
        if (!isApprove && !isDeny && !isExpired) continue;
        const key = `${s.id}:${dec.callId}`;
        if (seenResolutions.has(key)) continue;
        seenResolutions.add(key);
        if (isApprove) stats.deferredApproved++;
        else if (isDeny) stats.deferredDenied++;
        else stats.deferredExpired++;
      }
    }
  });
}

function groupPendingForProbe(t: Tx, inboxId: InboxId) {
  const groups = new Map<string, ReturnType<Tx["listPending"]>>();
  for (const e of t.listPending(inboxId)) {
    const key = e.resume !== null ? `session:${e.resume}` : e.thread !== null ? `thread:${e.thread}` : "none";
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()];
}

function probeNextClaimable(
  store: Store,
  inboxId: InboxId,
  now: number,
  debounceMs: number,
  mode: "kernel" | "harness",
): { claimable: boolean; maxAttempts: number; hasInRun: boolean } {
  return store.tx((t) => {
    const events = t.listEvents(inboxId);
    const hasInRun = events.some((e) => e.status === "in_run");
    if (hasInRun) {
      return { claimable: false, maxAttempts: 0, hasInRun: true };
    }
    for (let group of groupPendingForProbe(t, inboxId)) {
      const head = group[0]!;
      const existing = head.resume === null ? null : t.getSession(head.resume);
      const answer =
        existing?.status === "paused"
          ? group.find(
              (e) =>
                e.source === "approval_answer" &&
                existing.pending !== null &&
                (e.payload as { callId?: unknown } | null)?.callId === existing.pending,
            )
          : undefined;
      if (existing?.status === "paused" && !answer) continue;

      const readyAt = Math.max(
        Math.max(...group.map((e) => e.receivedAt)) + debounceMs,
        ...group.map((e) => e.nextAttemptAt),
      );
      if (readyAt > now) continue;

      if (mode === "harness") {
        let admitted = new Set<EventId>();
        const pending = answer && existing?.pending ? t.getDeferred(existing.pending) : null;
        if (pending?.kind === "admit" && answer) {
          const verdict = (answer.payload as { verdict?: unknown } | null)?.verdict;
          const covered = new Set((pending.args as { events: EventId[] }).events);
          if (verdict === "approve") {
            admitted = covered;
          } else {
            group = group.filter((e) => e !== answer && !covered.has(e.id));
          }
        }
        const unadmitted = group.filter((e) => !e.trusted && e.attempts === 0 && !admitted.has(e.id));
        if (unadmitted.length > 0) {
          if (answer && group.includes(answer)) {
            group = group.filter((e) => !unadmitted.includes(e));
          } else {
            continue;
          }
        }
        if (group.length === 0) continue;
      }

      const maxAttempts = Math.max(...group.map((e) => e.attempts));
      return { claimable: true, maxAttempts, hasInRun: false };
    }
    return { claimable: false, maxAttempts: 0, hasInRun: false };
  });
}

function listReadyHeads(store: Store, inboxId: InboxId, now: number): QueuedMsg[] {
  return store.tx((t) => {
    const heads = new Map<SessionId, QueuedMsg>();
    for (const q of t.listUndelivered(inboxId)) {
      if (!heads.has(q.msg.sessionId)) heads.set(q.msg.sessionId, q);
    }
    return [...heads.values()].filter((q) => q.nextAttemptAt <= now);
  });
}

function canDeliverNow(store: Store, inboxId: InboxId, now: number, ratePolicy: RatePolicy): boolean {
  return store.tx((t) => {
    const heads = new Map<SessionId, QueuedMsg>();
    for (const q of t.listUndelivered(inboxId)) {
      if (!heads.has(q.msg.sessionId)) heads.set(q.msg.sessionId, q);
    }
    const due = [...heads.values()].filter((q) => q.nextAttemptAt <= now).map((q) => q.msg);
    if (due.length === 0) return false;
    const recentSent = t.listSentTimes(inboxId, now - Math.max(ratePolicy.windowMs, ratePolicy.minIntervalMs));
    return pace(due, recentSent, now, ratePolicy).send.length > 0;
  });
}

function isTerminalState(store: Store, inboxId: InboxId): boolean {
  return store.tx((t) => {
    const eventsDone = t
      .listEvents(inboxId)
      .every((e) => e.status === "done" || e.status === "dropped" || e.status === "dead");
    if (!eventsDone) return false;
    if (t.listDeferred(inboxId).length > 0) return false;
    const outboxDone = t
      .listOutbox(inboxId)
      .every((m) => m.status === "sent" || m.status === "failed" || m.status === "cancelled");
    if (!outboxDone) return false;
    const armedFollowUps = t.listTimers(inboxId).some((tm) => tm.kind === "follow_up" && tm.status === "armed");
    return !armedFollowUps;
  });
}

type DrainToQuiescenceParams = {
  h: Harness;
  runtime: DstRuntime;
  channel: Channel;
  memory: Memory;
  policy: PolicyConfig;
  makeTools: (store: Store) => ToolDef[];
  monitor: ActivityMonitor;
  maxRounds: number;
  trace: string[];
  stats: FaultStats;
  seenDead: Set<EventId>;
  seenDeferred: Set<CallId>;
  seenResolutions: Set<string>;
  ctx: InvariantContext;
};

async function drainToQuiescence(p: DrainToQuiescenceParams): Promise<void> {
  const { h, runtime, channel, memory, policy, makeTools, monitor, maxRounds, trace } = p;

  // 1. Cancel all armed schedule timers so recurring schedules do not generate infinite new work.
  h.store.tx((t) => {
    for (const tm of t.listTimers(h.inboxId)) {
      if (tm.kind === "schedule" && tm.status === "armed") {
        t.cancelTimer(tm.id);
      }
    }
  });

  // 2. Put runtime into quiescing mode so no new deferrals or follow-up timers are initiated.
  runtime.quiescing = true;
  trace.push("quiesce:start");

  const poller = h.poller({ channel: channel as Required<Channel> });
  const scheduler = h.scheduler();
  const worker = h.worker({
    runtime: runtime.asRuntime(),
    tools: makeTools(h.store),
    memory,
    policy,
    debounceMs: 0,
    onRunStart: monitor.onRunStart,
    onRunEnd: monitor.onRunEnd,
    onActivity: monitor.onActivity,
  });
  const dispatcher = h.dispatcher({ channel, policy: UNPACED_POLICY });

  for (let round = 0; round < maxRounds; round++) {
    await poller.pass();
    scheduler.pass();

    const expiredRuns = new Set<RunId>();
    h.store.tx((t) => {
      const now = h.clock.now();
      for (const e of t.listEvents(h.inboxId)) {
        if (e.status === "in_run" && e.leaseUntil !== null && e.leaseUntil <= now && e.run !== null) {
          expiredRuns.add(e.run);
        }
      }
    });
    const drainRes = await worker.drain();
    if (expiredRuns.size > 0) p.stats.leaseExpirations += expiredRuns.size;

    const dispRes = await dispatcher.pass();
    syncStoreStats(h.store, h.inboxId, p.stats, p.seenDead, p.seenDeferred, p.seenResolutions);

    if (isTerminalState(h.store, h.inboxId)) {
      trace.push(`quiesce:done(rounds=${round + 1})`);
      break;
    }

    const now = h.clock.now();
    const nextTimerDue = h.store.tx((t) => t.nextTimerDue(h.inboxId));
    const candidates = [nextTimerDue, drainRes.nextReadyAt, dispRes.nextCheckAt].filter(
      (x): x is number => x !== null,
    );
    if (candidates.length === 0) continue;
    const minNext = Math.min(...candidates);
    if (minNext > now) {
      h.clock.advance(minNext - now);
    }
  }

  checkQuiescence(p.ctx);
}

function createSharedSimState(config: SimConfig) {
  const rootPrng = new Prng(config.seed);
  const prng = rootPrng.fork("actions");
  const uuidPrng = rootPrng.fork("uuid");
  const runtimePrng = rootPrng.fork("runtime");
  const factory = config.storeFactory ?? sqliteFactory;
  const faultProfile = config.faultProfile ?? "standard";
  const debounceMs = config.debounceMs ?? 0;
  const ratePolicy = config.ratePolicy ?? DEFAULT_RATE_POLICY;

  const h = new Harness(factory());
  writeFileSync(join(h.memoryDir, "instructions.md"), INITIAL_INSTRUCTIONS, "utf8");
  const memory = dirMemory(h.memoryDir);
  const channel = new FakeChannel();
  const effects = createEffectLog();
  const shadow = createShadowState(INITIAL_INSTRUCTIONS);
  const policy = createDstPolicy(hashSeed(`${config.seed}:policy`));
  const runtime = new DstRuntime(runtimePrng, effects, { kind: config.mode });
  const stats = emptyStats();
  const trace: string[] = [];

  const armedFailures: DeliveryFailure[] = [];
  const trackedChannel: Channel & Pick<Required<Channel>, "poll"> = {
    async deliver(m) {
      try {
        await channel.deliver(m);
      } catch (err) {
        const failure = armedFailures.shift();
        if (failure === "before_accept") stats.channelBeforeAccept++;
        else if (failure === "after_accept") stats.channelAfterAccept++;
        throw err;
      }
    },
    poll: (cursor) => channel.poll(cursor),
  };

  const slowCtrl: SlowToolController = {
    armed: false,
    started: false,
    onStarted: null,
  };

  const makeTools = (store: Store): ToolDef[] => [
    ...createDstTools(effects, {
      onSlowTool(signal) {
        if (!slowCtrl.armed) return null;
        slowCtrl.started = true;
        slowCtrl.onStarted?.();
        return new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
    ...outboxTools({ store, clock: h.clock, inboxId: h.inboxId }),
    ...timerTools({ store, clock: h.clock, inboxId: h.inboxId }),
    ...followTools({ store, inboxId: h.inboxId }),
    ...askUserTools(),
    ...memoryTools(memory),
  ];

  const seenDead = new Set<EventId>();
  const seenDeferred = new Set<CallId>();
  const seenResolutions = new Set<string>();
  const knownThreads: string[] = [];
  const acceptedKeys: AcceptedSpec[] = [];
  const knownSchedules: ScheduledSpec[] = [];
  let seq = 0;
  let threadSeq = 0;

  const ctx: InvariantContext = {
    get store() {
      return h.store;
    },
    inboxId: h.inboxId,
    clock: h.clock,
    channel,
    memoryDir: h.memoryDir,
    effects,
    shadow,
  };

  const nextThread = (): string => {
    const t = `thread-${++threadSeq}`;
    knownThreads.push(t);
    return t;
  };

  const buildIncomingEvent = (forChannel: boolean): NewEvent => {
    const pausedSessions = h.store.tx((t) =>
      t
        .listSessions(h.inboxId)
        .filter((s) => s.status === "paused" && s.pending !== null)
        .map((s) => ({ session: s, primaryThread: t.primaryThread(s.id) }))
        .filter((x): x is { session: Session; primaryThread: string } => x.primaryThread !== null),
    );

    if (pausedSessions.length > 0 && prng.bool(0.35)) {
      const target = prng.pick(pausedSessions);
      const replyKind = prng.weighted([
        { weight: 4, value: "approve" },
        { weight: 3, value: "deny" },
        { weight: 2, value: "free_text" },
        { weight: 1, value: "untrusted" },
      ] as const);
      const text =
        replyKind === "approve"
          ? "/approve"
          : replyKind === "deny"
            ? "/deny nope"
            : replyKind === "free_text"
              ? "looks reasonable"
              : "untrusted /approve";
      const key = `${forChannel ? "ch" : "ev"}-${++seq}`;
      return {
        source: "user_message",
        dedupeKey: key,
        thread: target.primaryThread,
        payload: { text },
        trusted: replyKind !== "untrusted",
      };
    }

    if (acceptedKeys.length > 0 && prng.bool(0.18)) {
      const dup = prng.pick(acceptedKeys);
      return {
        source: dup.source,
        dedupeKey: dup.dedupeKey,
        payload: dup.payload,
        ...(dup.thread !== undefined ? { thread: dup.thread } : {}),
        trusted: dup.trusted,
      };
    }

    const threadChoice = prng.weighted([
      { weight: 4, value: "new" },
      { weight: 4, value: "existing" },
      { weight: 2, value: "none" },
    ] as const);
    const thread =
      threadChoice === "new"
        ? nextThread()
        : threadChoice === "existing" && knownThreads.length > 0
          ? prng.pick(knownThreads)
          : threadChoice === "existing"
            ? nextThread()
            : undefined;

    const kind = prng.weighted([
      { weight: 5, value: "user_trusted" },
      { weight: 2, value: "user_untrusted" },
      { weight: 2, value: "webhook" },
      { weight: 2, value: "agent_message" },
    ] as const);
    const idNum = ++seq;
    const dedupeKey = `${forChannel ? "ch" : "ev"}-${idNum}`;
    if (kind === "webhook") {
      return {
        source: "webhook",
        dedupeKey,
        payload: { text: `webhook payload ${idNum}` },
        ...(thread !== undefined ? { thread } : {}),
        trusted: false,
      };
    }
    if (kind === "agent_message") {
      return {
        source: "agent_message",
        dedupeKey,
        payload: { text: `agent note ${idNum}`, from: "peer-agent" },
        ...(thread !== undefined ? { thread } : {}),
        trusted: prng.bool(0.5),
      };
    }
    return {
      source: "user_message",
      dedupeKey,
      payload: { text: `user message ${idNum}` },
      ...(thread !== undefined ? { thread } : {}),
      trusted: kind === "user_trusted",
    };
  };

  const acceptedSet = new Set<string>();
  const recordAccepted = (ev: NewEvent, status: "pending" | "dropped"): void => {
    const key = `${ev.source}:${ev.dedupeKey}`;
    if (status === "pending" && !acceptedSet.has(key)) {
      acceptedSet.add(key);
      acceptedKeys.push({
        source: ev.source,
        dedupeKey: ev.dedupeKey,
        payload: ev.payload,
        ...(ev.thread !== undefined ? { thread: ev.thread } : {}),
        trusted: ev.trusted,
      });
    }
  };

  const applyTimerOp = (): { label: string; wakeup: boolean } => {
    const allSessions = h.store.tx((t) => t.listSessions(h.inboxId));
    const liveSessions = allSessions.filter((s) => s.status !== "closed");
    const closedSessionIds = new Set(allSessions.filter((s) => s.status === "closed").map((s) => s.id));
    const liveSchedules = knownSchedules.filter(
      (spec) => spec.sessionId === undefined || !closedSessionIds.has(spec.sessionId),
    );
    const armedTimers = h.store.tx((t) =>
      t.listTimers(h.inboxId).filter((tm) => tm.status === "armed" && !tm.id.startsWith("expire:")),
    );
    const op = prng.weighted([
      { weight: liveSessions.length > 0 ? 3 : 0, value: "follow_up" as const },
      { weight: 3, value: "add_schedule" as const },
      { weight: liveSchedules.length > 0 ? 3 : 0, value: "put_schedule" as const },
      { weight: armedTimers.length > 0 ? 2 : 0, value: "cancel" as const },
    ]);

    const now = h.clock.now();
    if (op === "follow_up") {
      const s = prng.pick(liveSessions);
      const due = now + prng.int(500, 180_000);
      const tm = addFollowUp(h.store, h.inboxId, { sessionId: s.id, due, payload: { note: `fu-${++seq}` } });
      return { label: `timer:follow_up(${tm.id})`, wakeup: true };
    }
    if (op === "add_schedule") {
      const everyMs = prng.int(10_000, 120_000);
      const anchor = now + prng.int(-60_000, 60_000);
      const sessionId = liveSessions.length > 0 && prng.bool(0.4) ? prng.pick(liveSessions).id : undefined;
      const payload = { job: `sched-${++seq}` };
      const tm = addSchedule(h.store, h.clock, h.inboxId, {
        everyMs,
        anchor,
        payload,
        ...(sessionId ? { sessionId } : {}),
      });
      knownSchedules.push({ id: tm.id, everyMs, anchor, payload, ...(sessionId ? { sessionId } : {}) });
      return { label: `timer:add_schedule(${tm.id})`, wakeup: true };
    }
    if (op === "put_schedule") {
      const spec = prng.pick(liveSchedules);
      if (prng.bool(0.5)) {
        putSchedule(h.store, h.clock, h.inboxId, spec.id, {
          everyMs: spec.everyMs,
          anchor: spec.anchor,
          payload: spec.payload,
          ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
        });
        return { label: `timer:put_same(${spec.id})`, wakeup: false };
      }
      const everyMs = prng.int(10_000, 120_000);
      const anchor = now + prng.int(-30_000, 60_000);
      const payload = { job: `sched-upd-${++seq}` };
      putSchedule(h.store, h.clock, h.inboxId, spec.id, {
        everyMs,
        anchor,
        payload,
        ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
      });
      spec.everyMs = everyMs;
      spec.anchor = anchor;
      spec.payload = payload;
      return { label: `timer:put_update(${spec.id})`, wakeup: true };
    }
    const target = prng.pick(armedTimers);
    h.store.tx((t) => t.cancelTimer(target.id));
    return { label: `timer:cancel(${target.id})`, wakeup: false };
  };

  const applyAnswerDeferred = (): string => {
    const deferred = h.store.tx((t) => t.listDeferred(h.inboxId));
    if (deferred.length === 0) return "answer:none";
    const d = prng.pick(deferred);
    const verdict = prng.weighted([
      { weight: 6, value: "approve" as const },
      { weight: 4, value: "deny" as const },
    ]);
    const text = verdict === "deny" ? "dst denied" : "dst approved";
    const res = answerDeferred(h.store, h.clock, h.inboxId, d.callId, verdict, text, "cli");
    if (prng.bool(0.35)) {
      const dup = answerDeferred(h.store, h.clock, h.inboxId, d.callId, verdict, text, "cli");
      if (dup.status !== "dropped") {
        throw new Error(`[I-PRM-5/C16] duplicate answerDeferred for ${d.callId} returned status=${dup.status}`);
      }
    }
    return `answer:${d.kind}:${verdict}:${res.status}`;
  };

  const finalizeResult = (): SimResult => {
    const finalEvents = h.store.tx((t) =>
      t.listEvents(h.inboxId).map((e) => ({
        source: e.source,
        dedupeKey: e.dedupeKey,
        status: e.status,
      })),
    );
    const visibleMessages = channel.visible.map((m) => ({
      kind: m.kind,
      dedupeKey: m.dedupeKey,
      body: m.body,
    }));
    return {
      seed: config.seed,
      steps: config.steps,
      trace,
      stats,
      finalEvents,
      visibleMessages,
      harnessExecutions: effects.harnessExecutions.length,
    };
  };

  return {
    rootPrng,
    prng,
    uuidPrng,
    faultProfile,
    debounceMs,
    ratePolicy,
    h,
    memory,
    channel,
    trackedChannel,
    armedFailures,
    effects,
    policy,
    runtime,
    stats,
    trace,
    slowCtrl,
    makeTools,
    seenDead,
    seenDeferred,
    seenResolutions,
    ctx,
    buildIncomingEvent,
    recordAccepted,
    applyTimerOp,
    applyAnswerDeferred,
    finalizeResult,
  };
}

/** Runs a deterministic single-step-at-a-time fault-injecting state-machine simulation. */
export async function runSimulation(config: SimConfig): Promise<SimResult> {
  const s = createSharedSimState(config);
  const crashProb = s.faultProfile === "chaos" ? 0.25 : 0.12;
  const monitor = createActivityMonitor(s.effects, s.stats);

  const makeWorker = (crash?: ReturnType<typeof crashAt>) =>
    s.h.worker({
      runtime: s.runtime.asRuntime(),
      tools: s.makeTools(s.h.store),
      memory: s.memory,
      policy: s.policy,
      debounceMs: s.debounceMs,
      ...(crash ? { crash } : {}),
      onRunStart: monitor.onRunStart,
      onRunEnd: monitor.onRunEnd,
      onActivity: monitor.onActivity,
    });

  const makeScheduler = (crash?: ReturnType<typeof crashAt>) =>
    s.h.scheduler(crash ? { crash } : {});

  const makeDispatcher = (crash?: ReturnType<typeof crashAt>, customPolicy?: RatePolicy) =>
    s.h.dispatcher({
      channel: s.trackedChannel,
      policy: customPolicy ?? s.ratePolicy,
      ...(crash ? { crash } : {}),
    });

  const makePoller = (crash?: ReturnType<typeof crashAt>) =>
    s.h.poller({
      channel: s.trackedChannel,
      ...(crash ? { crash } : {}),
    });

  let worker = makeWorker();
  let scheduler = makeScheduler();
  let dispatcher = makeDispatcher();
  let poller = makePoller();

  const rebuildAll = () => {
    worker = makeWorker();
    scheduler = makeScheduler();
    dispatcher = makeDispatcher();
    poller = makePoller();
  };

  try {
    return await withDeterministicUuid(s.uuidPrng, async () => {
      for (let step = 1; step <= config.steps; step++) {
        let stepDesc = "";
        try {
          const now = s.h.clock.now();
          const { hasDeferred, closableSessions } = s.h.store.tx((t) => {
            const inRunSessions = new Set<SessionId>();
            for (const e of t.listEvents(s.h.inboxId)) {
              if (e.status === "in_run" && e.resume !== null) inRunSessions.add(e.resume);
            }
            return {
              hasDeferred: t.listDeferred(s.h.inboxId).length > 0,
              closableSessions: t
                .listSessions(s.h.inboxId)
                .filter((sess) => !s.effects.activeSessions.has(sess.id) && !inRunSessions.has(sess.id)),
            };
          });
          const probe = probeNextClaimable(s.h.store, s.h.inboxId, now, s.debounceMs, config.mode);

          const action = s.prng.weighted([
            { weight: 18, value: "append_event" as const },
            { weight: hasDeferred ? 10 : 0, value: "answer_deferred" as const },
            { weight: 8, value: "poller_pass" as const },
            { weight: 8, value: "timer_op" as const },
            { weight: 10, value: "scheduler_pass" as const },
            { weight: 20, value: "worker_drain" as const },
            { weight: probe.claimable ? (s.faultProfile === "chaos" ? 10 : 7) : 0, value: "worker_concurrent_or_stop" as const },
            { weight: 12, value: "dispatcher_pass" as const },
            { weight: closableSessions.length > 0 && s.effects.activeSessions.size === 0 ? 4 : 0, value: "close_session" as const },
            { weight: 12, value: "advance_clock" as const },
            { weight: s.faultProfile === "chaos" ? 8 : 5, value: "restart" as const },
          ]);

          switch (action) {
            case "append_event": {
              const ev = s.buildIncomingEvent(false);
              const crash = s.prng.bool(crashProb) ? crashAt("after_append") : undefined;
              let resStatus = "crashed";
              try {
                const res = appendEvent(
                  { store: s.h.store, clock: s.h.clock, inboxId: s.h.inboxId, ...(crash ? { crash } : {}) },
                  ev,
                );
                resStatus = res.status;
                s.recordAccepted(ev, res.status);
              } catch (err) {
                if (!(err instanceof SimulatedCrash)) throw err;
                recordCrashStat(s.stats, err.point);
                s.recordAccepted(ev, "pending");
              }
              stepDesc = `append(${ev.source},${ev.dedupeKey})->${resStatus}`;
              break;
            }

            case "answer_deferred": {
              stepDesc = s.applyAnswerDeferred();
              break;
            }

            case "poller_pass": {
              const count = s.prng.int(1, 3);
              const pushed: NewEvent[] = [];
              for (let i = 0; i < count; i++) {
                const ev = s.buildIncomingEvent(true);
                pushed.push(ev);
              }
              s.channel.push(...pushed);
              const willCrash = s.prng.bool(crashProb);
              const activePoller = willCrash ? makePoller(crashAt("after_poll")) : poller;
              try {
                const res = await activePoller.pass();
                for (const ev of pushed) s.recordAccepted(ev, "pending");
                stepDesc = `poller(pushed=${count},accepted=${res.accepted})`;
              } catch (err) {
                if (!(err instanceof SimulatedCrash)) throw err;
                recordCrashStat(s.stats, err.point);
                poller = makePoller();
                stepDesc = `poller(pushed=${count},crash=${err.point})`;
              }
              break;
            }

            case "timer_op": {
              stepDesc = s.applyTimerOp().label;
              break;
            }

            case "scheduler_pass": {
              const hasDueTimers = s.h.store.tx((t) => t.listDueTimers(s.h.inboxId, now).length > 0);
              const willCrash = hasDueTimers && s.prng.bool(s.faultProfile === "chaos" ? 0.3 : 0.2);
              const activeSched = willCrash ? makeScheduler(crashAt("after_timer_fire")) : scheduler;
              try {
                const res = activeSched.pass();
                let secondFired = 0;
                if (s.prng.bool(0.3)) {
                  const second = scheduler.pass();
                  secondFired = second.fired;
                  if (secondFired !== 0) {
                    throw new Error(`[I-TMR-1/C7] immediate second scheduler.pass() fired ${secondFired} timers at same now`);
                  }
                }
                stepDesc = `scheduler(fired=${res.fired},second=${secondFired})`;
              } catch (err) {
                if (!(err instanceof SimulatedCrash)) throw err;
                recordCrashStat(s.stats, err.point);
                scheduler = makeScheduler();
                stepDesc = `scheduler(crash=${err.point})`;
              }
              break;
            }

            case "worker_drain": {
              const expiredRuns = new Set<RunId>();
              s.h.store.tx((t) => {
                for (const e of t.listEvents(s.h.inboxId)) {
                  if (e.status === "in_run" && e.leaseUntil !== null && e.leaseUntil <= now && e.run !== null) {
                    expiredRuns.add(e.run);
                  }
                }
              });

              const faultBias =
                probe.maxAttempts >= 2
                  ? s.faultProfile === "chaos"
                    ? 0.85
                    : 0.7
                  : probe.maxAttempts === 1
                    ? s.faultProfile === "chaos"
                      ? 0.7
                      : 0.55
                    : s.faultProfile === "chaos"
                      ? 0.45
                      : 0.3;

              let activeWorker = worker;
              let faultTag = "ok";
              if (s.prng.bool(faultBias)) {
                const faultKind = s.prng.weighted([
                  { weight: 3, value: "after_claim" as const },
                  { weight: 3, value: "after_tool_exec" as const },
                  { weight: 3, value: "after_tool_result" as const },
                  { weight: 3, value: "before_complete" as const },
                  { weight: probe.claimable ? 4 : 0, value: "fail_runtime" as const },
                ]);
                if (faultKind === "fail_runtime") {
                  s.runtime.pushDirective({ failAfterCalls: true });
                  faultTag = "fail_runtime";
                } else {
                  activeWorker = makeWorker(crashAt(faultKind));
                  faultTag = `arm:${faultKind}`;
                }
              }

              try {
                const res = await activeWorker.drain();
                stepDesc = `drain(runs=${res.runs},${faultTag})`;
              } catch (err) {
                if (!(err instanceof SimulatedCrash)) throw err;
                recordCrashStat(s.stats, err.point);
                worker = makeWorker();
                stepDesc = `drain(crash=${err.point})`;
              } finally {
                if (expiredRuns.size > 0) {
                  s.stats.leaseExpirations += expiredRuns.size;
                }
              }
              break;
            }

            case "worker_concurrent_or_stop": {
              if (s.prng.bool(0.5)) {
                // Subcase A: competing worker + lease renewal.
                const g = makeGate();
                const runsBefore = s.runtime.runs.length;
                s.runtime.pushDirective({ holdGate: g.promise });
                const draining = worker.drain();
                try {
                  const raced = await Promise.race([
                    draining.then(() => "done" as const),
                    s.runtime.started(runsBefore + 1).then(() => "started" as const),
                  ]);
                  if (raced === "started") {
                    const leaseBefore = s.h.store.tx(
                      (t) => t.listEvents(s.h.inboxId).find((e) => e.status === "in_run")?.leaseUntil ?? null,
                    );
                    s.h.clock.advance(2 * LEASE_MS);
                    const leaseAfter = s.h.store.tx(
                      (t) => t.listEvents(s.h.inboxId).find((e) => e.status === "in_run")?.leaseUntil ?? null,
                    );
                    if (leaseBefore !== null && leaseAfter !== null && leaseAfter > leaseBefore) {
                      s.stats.leaseRenewals += Math.max(1, Math.floor((leaseAfter - leaseBefore) / LEASE_RENEW_MS));
                    }
                    const store2 = s.h.connect();
                    const worker2 = s.h.worker({
                      store: store2,
                      runtime: s.runtime.asRuntime(),
                      tools: s.makeTools(store2),
                      memory: s.memory,
                      policy: s.policy,
                      debounceMs: s.debounceMs,
                    });
                    const competing = await worker2.drain();
                    if (competing.runs !== 0) {
                      throw new Error(`[I-EVT-1/C1] competing worker ran ${competing.runs} run(s) under active lease`);
                    }
                    s.stats.competingDrains++;
                  }
                  stepDesc = `concurrent_drain(${raced})`;
                } finally {
                  g.open();
                  await draining;
                }
              } else {
                // Subcase B: stop() mid-run or mid-slow-tool.
                s.slowCtrl.armed = true;
                s.slowCtrl.started = false;
                const runsBefore = s.runtime.runs.length;
                s.runtime.pushDirective({ hangAfterCalls: true });
                const draining = worker.drain();
                try {
                  const raced = await Promise.race([
                    draining.then(() => "done" as const),
                    s.runtime.started(runsBefore + 1).then(() => "started" as const),
                  ]);
                  if (raced === "started") {
                    for (let tick = 0; tick < 25 && !s.slowCtrl.started; tick++) {
                      await Promise.resolve();
                      if (monitor.inFlightTools.size === 0 && tick >= 3) break;
                    }
                    worker.stop();
                  }
                  stepDesc = `stop_mid_run(${raced},slow=${s.slowCtrl.started})`;
                } finally {
                  s.slowCtrl.armed = false;
                  s.slowCtrl.started = false;
                  await draining;
                  worker = makeWorker();
                }
              }
              break;
            }

            case "dispatcher_pass": {
              const readyHeads = listReadyHeads(s.h.store, s.h.inboxId, now);
              if (readyHeads.length > 0 && s.prng.bool(0.22)) {
                const unpaced = makeDispatcher(undefined, UNPACED_POLICY);
                const held = s.channel.holdNext();
                const passPromise = unpaced.pass();
                let released = false;
                let actionNote = "release";
                try {
                  await held.started;
                  const firstMsg = readyHeads[0]!.msg;
                  if (
                    firstMsg.kind === "approval_request" &&
                    firstMsg.callId !== null &&
                    s.h.store.tx((t) => t.getDeferred(firstMsg.callId!)) !== null &&
                    s.prng.bool(0.7)
                  ) {
                    const verdict = s.prng.pick(["approve", "deny"] as const);
                    answerDeferred(s.h.store, s.h.clock, s.h.inboxId, firstMsg.callId, verdict, "mid-delivery");
                    actionNote = `answer(${verdict})`;
                  } else if (s.prng.bool(0.5)) {
                    const ev = s.buildIncomingEvent(false);
                    const res = appendEvent({ store: s.h.store, clock: s.h.clock, inboxId: s.h.inboxId }, ev);
                    s.recordAccepted(ev, res.status);
                    actionNote = "append_in_flight";
                  }
                  if (s.prng.bool(0.35)) {
                    held.fail();
                    actionNote += "+fail";
                  } else {
                    held.release();
                    actionNote += "+ok";
                  }
                  released = true;
                  await passPromise;
                  s.stats.heldDeliveries++;
                  stepDesc = `dispatch_held(${actionNote})`;
                } finally {
                  if (!released) held.release();
                  await passPromise.catch(() => {});
                }
              } else {
                const sendable = canDeliverNow(s.h.store, s.h.inboxId, now, s.ratePolicy);
                let activeDisp = dispatcher;
                let note = "ok";
                if (sendable && s.prng.bool(s.faultProfile === "chaos" ? 0.35 : 0.22)) {
                  const failure = s.prng.pick(["before_accept", "after_accept"] as const);
                  s.armedFailures.push(failure);
                  s.channel.failNext(failure);
                  note = `fail=${failure}`;
                } else if (sendable && s.prng.bool(s.faultProfile === "chaos" ? 0.3 : 0.2)) {
                  activeDisp = makeDispatcher(crashAt("after_deliver"));
                  note = "arm=after_deliver";
                }
                try {
                  const res = await activeDisp.pass();
                  stepDesc = `dispatch(delivered=${res.delivered},${note})`;
                } catch (err) {
                  if (!(err instanceof SimulatedCrash)) throw err;
                  recordCrashStat(s.stats, err.point);
                  dispatcher = makeDispatcher();
                  stepDesc = `dispatch(crash=${err.point})`;
                }
              }
              break;
            }

            case "close_session": {
              const nonClosed = closableSessions.filter((sess) => sess.status !== "closed");
              const target = s.prng.pick(nonClosed.length > 0 ? nonClosed : closableSessions);
              closeSession(s.h.store, target.id);
              s.stats.sessionsClosed++;
              stepDesc = `close_session(${target.id})`;
              break;
            }

            case "advance_clock": {
              const longWeight = hasDeferred ? 4 : 2;
              const tier = s.prng.weighted([
                { weight: 5, value: "short" as const },
                { weight: 3, value: "medium" as const },
                { weight: longWeight, value: "long" as const },
              ]);
              const delta =
                tier === "short"
                  ? s.prng.int(500, 3_000)
                  : tier === "medium"
                    ? s.prng.int(30_000, 360_000)
                    : s.prng.int(Math.max(15 * 60_000, DEFER_TTL_MS), 25 * 60 * 60_000);
              s.h.clock.advance(delta);
              stepDesc = `advance(${tier}:${delta}ms)`;
              break;
            }

            case "restart": {
              s.h.restart();
              rebuildAll();
              s.stats.restarts++;
              stepDesc = "restart";
              break;
            }
          }

          s.trace.push(`#${step} ${stepDesc}`);
          syncStoreStats(s.h.store, s.h.inboxId, s.stats, s.seenDead, s.seenDeferred, s.seenResolutions);
          checkInvariants(s.ctx);
        } catch (err) {
          throw wrapDstError(err, { seed: config.seed, mode: config.mode, step, trace: s.trace });
        }
      }

      try {
        await drainToQuiescence({
          h: s.h,
          runtime: s.runtime,
          channel: s.trackedChannel,
          memory: s.memory,
          policy: s.policy,
          makeTools: s.makeTools,
          monitor,
          maxRounds: Math.max(60, config.steps * 2),
          trace: s.trace,
          stats: s.stats,
          seenDead: s.seenDead,
          seenDeferred: s.seenDeferred,
          seenResolutions: s.seenResolutions,
          ctx: s.ctx,
        });
      } catch (err) {
        throw wrapDstError(err, { seed: config.seed, mode: config.mode, step: "quiescence", trace: s.trace });
      }

      return s.finalizeResult();
    });
  } finally {
    s.h.dispose();
  }
}

async function yieldLoops(ticks = 25): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

/**
 * Runs concurrent `Worker.serve()`, `Scheduler.serve()`, `Dispatcher.serve()`, and `ChannelPoller.serve()`
 * loops on `FakeClock` across `steps` randomized async injections, then drains to quiescence.
 */
export async function runServeSimulation(config: SimConfig): Promise<SimResult> {
  const s = createSharedSimState(config);
  let activeDispatcher: Dispatcher | null = null;
  const monitor = createActivityMonitor(s.effects, s.stats, () => {
    activeDispatcher?.wake();
  });

  const startLoops = () => {
    const dispatcher = s.h.dispatcher({ channel: s.trackedChannel, policy: s.ratePolicy });
    activeDispatcher = dispatcher;
    const worker = s.h.worker({
      runtime: s.runtime.asRuntime(),
      tools: s.makeTools(s.h.store),
      memory: s.memory,
      policy: s.policy,
      debounceMs: s.debounceMs,
      onRunStart: monitor.onRunStart,
      onRunEnd: monitor.onRunEnd,
      onActivity: monitor.onActivity,
    });
    const scheduler = s.h.scheduler({ onFire: () => worker.wake() });
    const poller = s.h.poller({
      channel: s.trackedChannel,
      onEvents: () => worker.wake(),
    });
    const done = Promise.all([
      worker.serve(),
      scheduler.serve(),
      dispatcher.serve(),
      poller.serve(),
    ]);
    return { worker, scheduler, dispatcher, poller, done };
  };

  const stopLoops = async (loops: ReturnType<typeof startLoops>) => {
    loops.worker.stop();
    loops.scheduler.stop();
    loops.dispatcher.stop();
    loops.poller.stop();
    activeDispatcher = null;
    await loops.done;
  };

  let loops = startLoops();

  try {
    return await withDeterministicUuid(s.uuidPrng, async () => {
      await yieldLoops();

      for (let step = 1; step <= config.steps; step++) {
        try {
          const hasDeferred = s.h.store.tx((t) => t.listDeferred(s.h.inboxId).length > 0);
          const action = s.prng.weighted([
            { weight: 25, value: "append_wake" as const },
            { weight: 15, value: "channel_push" as const },
            { weight: 12, value: "timer_wake" as const },
            { weight: hasDeferred ? 14 : 0, value: "answer_wake" as const },
            { weight: 24, value: "advance_clock" as const },
            { weight: 10, value: "stop_restart" as const },
          ]);

          let stepDesc = "";
          switch (action) {
            case "append_wake": {
              const ev = s.buildIncomingEvent(false);
              const res = appendEvent({ store: s.h.store, clock: s.h.clock, inboxId: s.h.inboxId }, ev);
              s.recordAccepted(ev, res.status);
              loops.worker.wake();
              stepDesc = `serve:append(${ev.source})->${res.status}`;
              break;
            }
            case "channel_push": {
              const count = s.prng.int(1, 2);
              const pushed: NewEvent[] = [];
              for (let i = 0; i < count; i++) pushed.push(s.buildIncomingEvent(true));
              s.channel.push(...pushed);
              stepDesc = `serve:channel_push(${count})`;
              break;
            }
            case "timer_wake": {
              const res = s.applyTimerOp();
              if (res.wakeup) loops.scheduler.wake();
              stepDesc = `serve:${res.label}`;
              break;
            }
            case "answer_wake": {
              stepDesc = `serve:${s.applyAnswerDeferred()}`;
              loops.worker.wake();
              break;
            }
            case "advance_clock": {
              const delta = hasDeferred && s.prng.bool(0.35)
                ? s.prng.int(DEFER_TTL_MS, 25 * 60 * 60_000)
                : s.prng.pick([1_000, 10_000, POLL_INTERVAL_MS, 180_000]);
              s.h.clock.advance(delta);
              stepDesc = `serve:advance(${delta}ms)`;
              break;
            }
            case "stop_restart": {
              await stopLoops(loops);
              s.h.restart();
              s.stats.restarts++;
              loops = startLoops();
              stepDesc = "serve:stop_restart";
              break;
            }
          }

          await yieldLoops();
          s.trace.push(`#${step} ${stepDesc}`);
          syncStoreStats(s.h.store, s.h.inboxId, s.stats, s.seenDead, s.seenDeferred, s.seenResolutions);
          checkInvariants(s.ctx);
        } catch (err) {
          throw wrapDstError(err, { seed: config.seed, mode: config.mode, step, trace: s.trace });
        }
      }

      try {
        await stopLoops(loops);
        await drainToQuiescence({
          h: s.h,
          runtime: s.runtime,
          channel: s.trackedChannel,
          memory: s.memory,
          policy: s.policy,
          makeTools: s.makeTools,
          monitor,
          maxRounds: Math.max(60, config.steps * 2),
          trace: s.trace,
          stats: s.stats,
          seenDead: s.seenDead,
          seenDeferred: s.seenDeferred,
          seenResolutions: s.seenResolutions,
          ctx: s.ctx,
        });
      } catch (err) {
        throw wrapDstError(err, { seed: config.seed, mode: config.mode, step: "quiescence", trace: s.trace });
      }

      return s.finalizeResult();
    });
  } finally {
    await stopLoops(loops).catch(() => {});
    s.h.dispose();
  }
}
