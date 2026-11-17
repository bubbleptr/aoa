import { SimulatedCrash, type CrashHook, type CrashPoint } from "./crash.ts";
import type { AgentRuntime, Clock, Store, Tx } from "./ports.ts";
import type { Memory } from "./memory.ts";
import { reportDead } from "./outbox.ts";
import { askPermission, holdUntrusted, resolveAdmit } from "./permission.ts";
import type { PolicyConfig } from "./policy.ts";
import { RESIDENT_RECENT_MESSAGES, buildResident } from "./resident.ts";
import { answers, resolveAnswer } from "./resume.ts";
import { wrapTools, type ToolContext } from "./tools.ts";
import type { Event, EventId, InboxId, RunEnd, RunId, RunInput, RunResult, Session, SessionId, ToolDef } from "./types.ts";

export const LEASE_MS = 5 * 60_000;
export const LEASE_RENEW_MS = 60_000;
export const MAX_ATTEMPTS = 3;
/**
 * How long a failed attempt's events wait before they may be claimed again, by attempt number (design §9).
 * The third failure is the last one, so it needs no delay of its own.
 */
export const RETRY_DELAYS_MS = [30_000, 120_000];

/** The retry delay after the `attempts`-th failed attempt of a run. */
export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1]!;
}

/** Where the events of an attempt that failed at `failedAt` may be claimed again. */
const retryAt = (attempts: number, failedAt: number) => failedAt + retryDelayMs(attempts);

export type WorkerOptions = {
  store: Store;
  runtime: AgentRuntime;
  clock: Clock;
  inboxId: InboxId;
  tools?: ToolDef[];
  crash?: CrashHook;
  /** A group is ready only once its newest event is at least this old (D-EVT-3). */
  debounceMs?: number;
  /**
   * Gives a session without a workdir its working directory (for a coding task, a worktree) before its run.
   * A crash between this call and storing its result makes the kernel call it again for the same session,
   * so it must be idempotent: return the same workdir when it already exists.
   */
  prepareSession?: (session: Session) => Promise<{ workdir: string }>;
  /** Decides every tool call (spec §6). Without one, each call goes by its tool's own tier and an untiered tool waits. */
  policy?: PolicyConfig;
  /** The inbox's memory directory, read into every run's resident context (spec §5). */
  memory?: Memory;
  /** Called when a run starts, with how many events it took. */
  onRunStart?: (run: { runId: RunId; sessionId: SessionId; events: number }) => void;
  /** Called once a run's outcome is stored: its end, or the error that sent its events back. */
  onRunEnd?: (run: RunOutcome) => void;
};

export type RunOutcome = { runId: RunId; sessionId: SessionId; end: RunEnd | null; error: string | null };

export type DrainResult = {
  runs: number;
  /** When the next pass could find work without a new event arriving; null if only a new event can. */
  nextReadyAt: number | null;
};

type Claim = { runId: RunId; session: Session; resumed: boolean; events: Event[] };

type Selection = { claim: Claim } | { claim: null; nextReadyAt: number | null };

export class Worker {
  private readonly store: Store;
  private readonly runtime: AgentRuntime;
  private readonly clock: Clock;
  private readonly inboxId: InboxId;
  private readonly tools: ToolDef[];
  private readonly crashHook: CrashHook;
  private readonly debounceMs: number;
  private readonly prepareSession: WorkerOptions["prepareSession"];
  private readonly policy: PolicyConfig | undefined;
  private readonly memory: Memory | undefined;
  private readonly onRunStart: NonNullable<WorkerOptions["onRunStart"]>;
  private readonly onRunEnd: NonNullable<WorkerOptions["onRunEnd"]>;

  /** Set once a crash point fires; from then on this worker behaves as a dead process. */
  private crashed: SimulatedCrash | null = null;
  private stopped = true;
  private woken = false;
  private wakeUp: (() => void) | null = null;
  /** How many times `stop()` was called, so a drain can tell it was stopped after it began. */
  private stops = 0;
  /** The signal of the run in flight. */
  private current: AbortController | null = null;

  constructor(o: WorkerOptions) {
    this.store = o.store;
    this.runtime = o.runtime;
    this.clock = o.clock;
    this.inboxId = o.inboxId;
    this.tools = o.tools ?? [];
    this.crashHook = o.crash ?? (() => {});
    this.debounceMs = o.debounceMs ?? 0;
    this.prepareSession = o.prepareSession;
    this.policy = o.policy;
    this.memory = o.memory;
    this.onRunStart = o.onRunStart ?? (() => {});
    this.onRunEnd = o.onRunEnd ?? (() => {});
  }

  /**
   * Runs every ready group, one run at a time, then returns. Each pass re-reads the store.
   * Returns early when another worker holds this inbox's lease, and after a `stop()`.
   */
  async drain(): Promise<DrainResult> {
    let runs = 0;
    const stops = this.stops;
    for (;;) {
      this.assertAlive();
      if (this.stops !== stops) return { runs, nextReadyAt: null };
      const selection = this.store.tx((t) => this.select(t, this.clock.now()));
      if (!selection.claim) return { runs, nextReadyAt: selection.nextReadyAt };
      await this.execute(selection.claim);
      runs++;
    }
  }

  /** Drains whenever woken or when the next group becomes ready, until `stop()`. */
  async serve(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      this.woken = false;
      const { nextReadyAt } = await this.drain();
      if (this.stopped || this.woken) continue;
      await this.sleep(nextReadyAt);
    }
  }

  /** A hint that new events may be pending. It carries nothing; the next pass reads the store. */
  wake(): void {
    this.woken = true;
    this.wakeUp?.();
  }

  /** Ends `serve()` and any `drain()`, and aborts the run in flight through its signal. */
  stop(): void {
    this.stopped = true;
    this.stops++;
    this.current?.abort(new Error("the host stopped"));
    this.wake();
  }

  private sleep(until: number | null): Promise<void> {
    return new Promise((resolve) => {
      let cancel = () => {};
      this.wakeUp = () => {
        cancel();
        this.wakeUp = null;
        resolve();
      };
      if (until !== null) cancel = this.clock.setTimer(Math.max(0, until - this.clock.now()), this.wakeUp);
    });
  }

  private select(t: Tx, now: number): Selection {
    reportDead(t, this.inboxId, t.expireLeases(this.inboxId, now, MAX_ATTEMPTS, retryAt), null, now);
    const lease = t.activeLease(this.inboxId, now);
    if (lease !== null) return { claim: null, nextReadyAt: lease };

    let nextReadyAt: number | null = null;
    for (let group of groupPending(t.listPending(this.inboxId))) {
      const head = group[0]!;
      const existing = head.resume === null ? null : t.getSession(head.resume);
      const answer = existing?.status === "paused" ? group.find((e) => answers(e, existing.pending)) : undefined;
      // A session waiting on a call runs again only with the answer to that call (I-PRM-4).
      if (existing?.status === "paused" && !answer) continue;

      // A group is ready once its debounce is over and whatever failed in it has waited out its retry delay,
      // so a delayed group holds back the session's later events too (design §9).
      const readyAt = Math.max(
        Math.max(...group.map((e) => e.receivedAt)) + this.debounceMs,
        ...group.map((e) => e.nextAttemptAt),
      );
      if (readyAt > now) {
        nextReadyAt = nextReadyAt === null ? readyAt : Math.min(nextReadyAt, readyAt);
        continue;
      }

      // A harness runtime's own tools are not the kernel's to guard, so untrusted input waits for the user instead.
      if (this.runtime.kind === "harness") {
        let admitted = new Set<EventId>();
        const pending = answer ? t.getDeferred(existing!.pending!) : null;
        if (pending?.kind === "admit") ({ group, admitted } = resolveAdmit(t, this.inboxId, pending, answer!, group, now));
        // An event a run has taken before was let in then; asking now would not take it back from the model.
        const unadmitted = group.filter((e) => !e.trusted && e.attempts === 0 && !admitted.has(e.id));
        if (unadmitted.length > 0) {
          // The answer must reach its session now; untrusted input that came with it waits to be asked about next.
          if (answer && group.includes(answer)) group = group.filter((e) => !unadmitted.includes(e));
          else {
            const session = existing ?? this.openSession(t, head.thread, now);
            holdUntrusted(t, this.inboxId, session.id, group, unadmitted, now);
            continue;
          }
        }
        if (group.length === 0) continue;
      }

      const session = existing ?? this.openSession(t, head.thread, now);
      const runId = crypto.randomUUID();
      const ids = group.map((e) => e.id);
      // Pinning the session onto the events makes a retry resume it, so the tool journal still matches.
      if (!t.claimEvents(this.inboxId, ids, runId, session.id, now, now + LEASE_MS)) {
        throw new Error(`claim of ${ids.length} events failed inside the selecting transaction`);
      }
      if (session.status === "closed") t.setSessionStatus(session.id, "open");
      if (group.some((e) => !e.trusted)) t.markTainted(session.id);
      t.insertRun({ id: runId, inboxId: this.inboxId, sessionId: session.id, events: ids, startedAt: now });
      return {
        claim: { runId, session: t.getSession(session.id)!, resumed: existing !== null, events: ids.map((id) => t.getEvent(id)!) },
      };
    }
    return { claim: null, nextReadyAt };
  }

  private openSession(t: Tx, thread: string | null, now: number): Session {
    const id = crypto.randomUUID();
    t.insertSession({ id, inboxId: this.inboxId, createdAt: now });
    if (thread !== null) t.registerThread(this.inboxId, thread, id);
    return t.getSession(id)!;
  }

  private async execute(claim: Claim): Promise<void> {
    this.crashAt("after_claim");
    this.onRunStart({ runId: claim.runId, sessionId: claim.session.id, events: claim.events.length });
    const stopRenewal = this.renewLease(claim.runId);
    const controller = new AbortController();
    this.current = controller;
    const { signal } = controller;
    const c = { ...claim };
    let result: RunResult;
    try {
      if (c.session.workdir === null && this.prepareSession) {
        const { workdir } = await this.prepareSession(c.session);
        this.assertAlive();
        this.store.tx((t) => t.setSessionWorkdir(c.session.id, workdir));
        c.session = { ...c.session, workdir };
      }
      const toolCtx: ToolContext = {
        store: this.store,
        clock: this.clock,
        inboxId: this.inboxId,
        sessionId: c.session.id,
        workdir: c.session.workdir,
        signal,
        policy: this.policy,
        crash: (p) => this.crashAt(p),
        assertAlive: () => this.assertAlive(),
      };
      const answer = await resolveAnswer(c.events, this.tools, toolCtx);
      const sent = this.store.tx((t) => t.listRecentSent(this.inboxId, RESIDENT_RECENT_MESSAGES));
      const resident = await buildResident(this.memory, c.session.id, sent);
      this.assertAlive();
      const input: RunInput = {
        runId: c.runId,
        session: { id: c.session.id, resumed: c.resumed, ref: c.session.runtimeRef, workdir: c.session.workdir },
        events: c.events,
        resident,
        tools: wrapTools(this.tools, toolCtx),
        ...(answer ? { answer } : {}),
        signal,
      };
      result =
        this.runtime.kind === "harness"
          ? await this.runtime.run({ ...input, ask: (a) => askPermission(toolCtx, a) })
          : await this.runtime.run(input);
    } catch (err) {
      // A crash stands in for the process dying: write nothing on the way out.
      if (this.crashed) throw this.crashed;
      if (err instanceof SimulatedCrash) throw err;
      if (signal.aborted) {
        // A stop is not the run's failure: the events go back ready for the next start, and no number of stops makes
        // them dead. The attempt still counts, so the next run knows an earlier one may have done part of the work.
        const error = "stopped: the host stopped during the run";
        this.store.tx((t) => {
          const now = this.clock.now();
          t.endRun(c.runId, { error }, now);
          t.releaseEvents(c.runId, now, Number.MAX_SAFE_INTEGER, () => now);
        });
        this.onRunEnd({ runId: c.runId, sessionId: c.session.id, end: null, error });
        return;
      }
      const error = err instanceof Error ? err.message : String(err);
      this.store.tx((t) => {
        const now = this.clock.now();
        t.endRun(c.runId, { error }, now);
        reportDead(t, this.inboxId, t.releaseEvents(c.runId, now, MAX_ATTEMPTS, retryAt), error, now);
      });
      this.onRunEnd({ runId: c.runId, sessionId: c.session.id, end: null, error });
      return;
    } finally {
      stopRenewal();
      this.current = null;
    }

    this.assertAlive();
    this.crashAt("before_complete");
    const outcome = this.store.tx((t): RunOutcome => {
      const now = this.clock.now();
      if (t.completeEvents(c.runId) === 0) {
        const error = "lost its lease before completing; the events were handed to another run";
        t.endRun(c.runId, { error }, now);
        return { runId: c.runId, sessionId: c.session.id, end: null, error };
      }
      const msgs = t.claimRunMessages(c.session.id, c.runId);
      const pending = t.getSession(c.session.id)!.pending;
      // The store, not the runtime, knows whether the session waits on a call; a run that wrote to the outbox has sent (design §3).
      const end: RunEnd =
        pending !== null
          ? { kind: "deferred", callId: pending }
          : result.end.kind === "silent" && msgs.length > 0
            ? { kind: "sent", msgs }
            : result.end;
      t.endRun(c.runId, { end }, now);
      t.recordSessionRun(c.session.id, c.runId, result.sessionRef ?? c.session.runtimeRef);
      return { runId: c.runId, sessionId: c.session.id, end, error: null };
    });
    this.onRunEnd(outcome);
  }

  private renewLease(runId: RunId): () => void {
    let cancel = () => {};
    const tick = () => {
      if (this.crashed) return;
      this.store.tx((t) => t.renewLease(runId, this.clock.now() + LEASE_MS));
      cancel = this.clock.setTimer(LEASE_RENEW_MS, tick);
    };
    cancel = this.clock.setTimer(LEASE_RENEW_MS, tick);
    return () => cancel();
  }

  private crashAt(point: CrashPoint): void {
    this.assertAlive();
    try {
      this.crashHook(point);
    } catch (err) {
      if (err instanceof SimulatedCrash) this.crashed = err;
      throw err;
    }
  }

  private assertAlive(): void {
    if (this.crashed) throw this.crashed;
  }
}

/**
 * Groups pending events (oldest first) by the session they belong to: `resume` if set,
 * else `thread`, else one shared "no key" group (design §4). Groups keep the order of their oldest event.
 */
function groupPending(pending: Event[]): Event[][] {
  const groups = new Map<string, Event[]>();
  for (const e of pending) {
    const key = e.resume !== null ? `session:${e.resume}` : e.thread !== null ? `thread:${e.thread}` : "none";
    const group = groups.get(key);
    if (group) group.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()];
}
