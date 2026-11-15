import { SimulatedCrash, type CrashHook, type CrashPoint } from "./crash.ts";
import type { AgentRuntime, Clock, Store, Tx } from "./ports.ts";
import type { PolicyConfig } from "./policy.ts";
import { answers, resolveAnswer } from "./resume.ts";
import { wrapTools, type ToolContext } from "./tools.ts";
import type { Event, InboxId, RunEnd, RunId, RunResult, Session, ToolDef } from "./types.ts";

export const LEASE_MS = 5 * 60_000;
export const LEASE_RENEW_MS = 60_000;
export const MAX_ATTEMPTS = 3;

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
  /** Decides every tool call (spec §6). Without one, every call is allowed. */
  policy?: PolicyConfig;
};

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

  /** Set once a crash point fires; from then on this worker behaves as a dead process. */
  private crashed: SimulatedCrash | null = null;
  private stopped = true;
  private woken = false;
  private wakeUp: (() => void) | null = null;

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
  }

  /**
   * Runs every ready group, one run at a time, then returns. Each pass re-reads the store.
   * Returns early when another worker holds this inbox's lease.
   */
  async drain(): Promise<DrainResult> {
    let runs = 0;
    for (;;) {
      this.assertAlive();
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

  stop(): void {
    this.stopped = true;
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
    t.expireLeases(this.inboxId, now, MAX_ATTEMPTS);
    const lease = t.activeLease(this.inboxId, now);
    if (lease !== null) return { claim: null, nextReadyAt: lease };

    let nextReadyAt: number | null = null;
    for (const group of groupPending(t.listPending(this.inboxId))) {
      const head = group[0]!;
      const existing = head.resume === null ? null : t.getSession(head.resume);
      // A session waiting on a call runs again only with the answer to that call (I-PRM-4).
      if (existing?.status === "paused" && !group.some((e) => answers(e, existing.pending))) continue;

      const readyAt = Math.max(...group.map((e) => e.receivedAt)) + this.debounceMs;
      if (readyAt > now) {
        nextReadyAt = nextReadyAt === null ? readyAt : Math.min(nextReadyAt, readyAt);
        continue;
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
    const stopRenewal = this.renewLease(claim.runId);
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
        policy: this.policy,
        crash: (p) => this.crashAt(p),
        assertAlive: () => this.assertAlive(),
      };
      const answer = await resolveAnswer(c.events, this.tools, toolCtx);
      this.assertAlive();
      result = await this.runtime.run({
        runId: c.runId,
        session: { id: c.session.id, resumed: c.resumed, ref: c.session.runtimeRef, workdir: c.session.workdir },
        events: c.events,
        resident: "",
        tools: wrapTools(this.tools, toolCtx),
        ...(answer ? { answer } : {}),
      });
    } catch (err) {
      // A crash stands in for the process dying: write nothing on the way out.
      if (this.crashed) throw this.crashed;
      if (err instanceof SimulatedCrash) throw err;
      const error = err instanceof Error ? err.message : String(err);
      this.store.tx((t) => {
        t.endRun(c.runId, { error }, this.clock.now());
        t.releaseEvents(c.runId, MAX_ATTEMPTS);
      });
      return;
    } finally {
      stopRenewal();
    }

    this.assertAlive();
    this.crashAt("before_complete");
    this.store.tx((t) => {
      const now = this.clock.now();
      if (t.completeEvents(c.runId) === 0) {
        t.endRun(c.runId, { error: "lost its lease before completing; the events were handed to another run" }, now);
        return;
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
    });
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
