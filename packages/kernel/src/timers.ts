import { SimulatedCrash, type CrashHook } from "./crash.ts";
import { appendInTx } from "./intake.ts";
import type { Clock, Store } from "./ports.ts";
import type { InboxId, Recurrence, SessionId, Timer, TimerId, ToolDef } from "./types.ts";

/** The longest the scheduler sleeps between passes (POLL_INTERVAL, design §9). */
export const SCHEDULER_MAX_SLEEP_MS = 60_000;

/** The first slot `anchor + k * everyMs` strictly after `now`. Computed from the anchor, so it never drifts (C9). */
export function nextSlot(r: Recurrence, now: number): number {
  if (now < r.anchor) return r.anchor;
  return r.anchor + (Math.floor((now - r.anchor) / r.everyMs) + 1) * r.everyMs;
}

export type FollowUpInput = { sessionId: SessionId; due: number; payload: unknown; id?: TimerId };

/** Creates an armed follow-up. With an explicit `id` that already exists, returns the existing timer. */
export function addFollowUp(store: Store, inboxId: InboxId, f: FollowUpInput): Timer {
  const id = f.id ?? crypto.randomUUID();
  return store.tx((t) => {
    t.insertTimer({ id, inboxId, kind: "follow_up", sessionId: f.sessionId, due: f.due, recurrence: null, payload: f.payload });
    return t.getTimer(id)!;
  });
}

export type ScheduleInput = { everyMs: number; anchor: number; payload: unknown; sessionId?: SessionId };

/** Creates an armed schedule whose first occurrence is the anchor, or the next slot if the anchor has passed. */
export function addSchedule(store: Store, clock: Clock, inboxId: InboxId, s: ScheduleInput): Timer {
  if (!(Number.isFinite(s.everyMs) && s.everyMs > 0)) throw new Error(`everyMs must be a positive number, got ${s.everyMs}`);
  const recurrence: Recurrence = { everyMs: s.everyMs, anchor: s.anchor };
  const now = clock.now();
  const id = crypto.randomUUID();
  return store.tx((t) => {
    t.insertTimer({
      id,
      inboxId,
      kind: "schedule",
      sessionId: s.sessionId ?? null,
      due: s.anchor >= now ? s.anchor : nextSlot(recurrence, now),
      recurrence,
      payload: s.payload,
    });
    return t.getTimer(id)!;
  });
}

export type SchedulerOptions = {
  store: Store;
  clock: Clock;
  inboxId: InboxId;
  crash?: CrashHook;
  /** Called after a pass that appended at least one event; the caller wakes the worker. */
  onFire?: () => void;
};

export type PassResult = { fired: number; nextDueAt: number | null };

/** Turns due timers into inbox events (spec §4.3). It never starts a run itself (I-TMR-2). */
export class Scheduler {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly inboxId: InboxId;
  private readonly crashHook: CrashHook;
  private readonly onFire: () => void;
  private crashed: SimulatedCrash | null = null;
  private stopped = true;
  private wakeUp: (() => void) | null = null;

  constructor(o: SchedulerOptions) {
    this.store = o.store;
    this.clock = o.clock;
    this.inboxId = o.inboxId;
    this.crashHook = o.crash ?? (() => {});
    this.onFire = o.onFire ?? (() => {});
  }

  /** Fires every timer due now, each in its own transaction, and reports the next due time. */
  pass(): PassResult {
    if (this.crashed) throw this.crashed;
    const now = this.clock.now();
    let fired = 0;
    for (const timer of this.store.tx((t) => t.listDueTimers(this.inboxId, now))) {
      if (this.fire(timer, now)) fired++;
      try {
        this.crashHook("after_timer_fire");
      } catch (err) {
        if (err instanceof SimulatedCrash) this.crashed = err;
        throw err;
      }
    }
    if (fired > 0) this.onFire();
    return { fired, nextDueAt: this.store.tx((t) => t.nextTimerDue(this.inboxId)) };
  }

  /** Passes until `stop()`, sleeping until the earliest due time but never longer than `SCHEDULER_MAX_SLEEP_MS`. */
  async serve(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      const { nextDueAt } = this.pass();
      const now = this.clock.now();
      const delay = nextDueAt === null ? SCHEDULER_MAX_SLEEP_MS : Math.min(Math.max(0, nextDueAt - now), SCHEDULER_MAX_SLEEP_MS);
      await this.sleep(delay);
    }
  }

  stop(): void {
    this.stopped = true;
    this.wakeUp?.();
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let cancel = () => {};
      this.wakeUp = () => {
        cancel();
        this.wakeUp = null;
        resolve();
      };
      cancel = this.clock.setTimer(ms, this.wakeUp);
    });
  }

  /**
   * One ATOMIC step: append the occurrence's event and advance the timer. The update is conditional on
   * the timer still being armed at this occurrence, so a second scheduler that saw the same row skips it.
   */
  private fire(timer: Timer, now: number): boolean {
    const occurrence = timer.due;
    const nextDue = timer.recurrence ? nextSlot(timer.recurrence, now) : null;
    return this.store.tx((t) => {
      if (!t.fireTimer(timer.id, occurrence, nextDue)) return false;
      appendInTx(
        t,
        this.inboxId,
        now,
        { source: "timer", dedupeKey: `${timer.id}:${occurrence}`, payload: timer.payload, trusted: true },
        timer.sessionId ?? undefined,
      );
      return true;
    });
  }
}

export type TimerToolDeps = { store: Store; clock: Clock; inboxId: InboxId };

type WakeArgs = { at?: string; inMs?: number; note: string };

/** Agent tools for follow-ups on the calling session: `wake_me_at` and `cancel_wake`. */
export function timerTools({ store, clock, inboxId }: TimerToolDeps): ToolDef[] {
  const wakeMeAt: ToolDef = {
    name: "wake_me_at",
    risk: "low",
    description:
      "Schedule a follow-up for this task: at the given time an event with your note wakes you in this same session. " +
      "Give either `at` (an ISO 8601 time) or `inMs` (milliseconds from now). Returns the timer id and its due time.",
    schema: {
      type: "object",
      properties: {
        at: { type: "string", format: "date-time", description: "When to wake, as an ISO 8601 time." },
        inMs: { type: "integer", minimum: 0, description: "How many milliseconds from now to wake." },
        note: { type: "string", description: "What to check or do when woken; it comes back as the event payload." },
      },
      required: ["note"],
      additionalProperties: false,
    },
    // The timer id is derived from the call, so executing the call again cannot create a second timer.
    idempotent: true,
    async execute(raw, ctx) {
      const args = raw as WakeArgs;
      if (typeof args.note !== "string") throw new Error("note must be a string");
      if ((args.at === undefined) === (args.inMs === undefined)) throw new Error("give exactly one of at or inMs");
      const due = args.at !== undefined ? Date.parse(args.at) : clock.now() + args.inMs!;
      if (!Number.isFinite(due)) throw new Error(`cannot parse at: ${args.at}`);
      const timer = addFollowUp(store, inboxId, {
        id: `wake:${ctx.sessionId}:${ctx.callId}`,
        sessionId: ctx.sessionId,
        due,
        payload: { note: args.note },
      });
      return { timerId: timer.id, due: new Date(timer.due).toISOString() };
    },
  };

  const cancelWake: ToolDef = {
    name: "cancel_wake",
    risk: "low",
    description:
      "Cancel a follow-up this task set earlier with wake_me_at. Returns whether an armed follow-up of this task was cancelled.",
    schema: {
      type: "object",
      properties: { timerId: { type: "string", description: "The timerId returned by wake_me_at." } },
      required: ["timerId"],
      additionalProperties: false,
    },
    idempotent: true,
    async execute(raw, ctx) {
      const { timerId } = raw as { timerId: string };
      if (typeof timerId !== "string") throw new Error("timerId must be a string");
      return { cancelled: store.tx((t) => t.cancelFollowUp(timerId, ctx.sessionId)) };
    },
  };

  return [wakeMeAt, cancelWake];
}
