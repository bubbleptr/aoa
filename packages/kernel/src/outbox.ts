import type { Channel, OutMsg } from "./channel.ts";
import { SimulatedCrash, type CrashHook, type CrashPoint } from "./crash.ts";
import { answerCallId, expiryTimerId } from "./deferred.ts";
import { DEFAULT_RATE_POLICY, pace, type RatePolicy } from "./pace.ts";
import type { Clock, Store } from "./ports.ts";
import type { Tx } from "./ports.ts";
import type { Event, InboxId, ToolDef } from "./types.ts";

/** Delivery attempts before a message is `failed` (MAX_ATTEMPTS for messages, D-OUT-5). */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** The longest the dispatcher sleeps between passes. */
export const DISPATCHER_MAX_SLEEP_MS = 60_000;

const MINUTE = 60_000;

export type OutboxToolDeps = { store: Store; clock: Clock; inboxId: InboxId };

/** The agent's way to speak: `notify` appends a message for the calling session to the outbox. */
export function outboxTools({ store, clock, inboxId }: OutboxToolDeps): ToolDef[] {
  const notify: ToolDef = {
    name: "notify",
    risk: "low",
    description:
      "Send the user a message about this task. Use it only when the user needs to know something " +
      "(you opened a PR, the task failed) or has to decide something. Ending a run without a message is normal; " +
      "do not report routine progress. Returns the message id.",
    schema: {
      type: "object",
      properties: { body: { type: "string", description: "The message, in Markdown." } },
      required: ["body"],
      additionalProperties: false,
    },
    // The dedupe key is derived from the call, so executing the call again cannot add a second message.
    idempotent: true,
    async execute(raw, ctx) {
      const { body } = raw as { body: string };
      if (typeof body !== "string" || body.trim() === "") throw new Error("body must be a non-empty string");
      const msgId = store.tx((t) =>
        t.insertOutMsg({
          id: crypto.randomUUID(),
          inboxId,
          sessionId: ctx.sessionId,
          thread: t.primaryThread(ctx.sessionId),
          kind: "message",
          body,
          callId: null,
          dedupeKey: `msg:${ctx.sessionId}:${ctx.callId}`,
          createdAt: clock.now(),
        }),
      );
      return { msgId };
    },
  };
  return [notify];
}

/** How much of a failed run's error the user is shown. */
export const DEAD_ERROR_LIMIT = 500;

/** The dedupe key prefix of a dead-letter notice, so an application can add its own last line in its channel. */
export const DEAD_NOTICE_PREFIX = "dead:";

/**
 * Tells the user that a task gave up (design §8: a failed task is one of the three times the agent speaks).
 * Runs inside the transaction that moved these events to `dead`, one message per session. `error` is the last
 * run's error, already scrubbed by the runtime; it is null when the run died without one (its lease ran out).
 */
export function reportDead(t: Tx, inboxId: InboxId, dead: Event[], error: string | null, now: number): void {
  const bySession = new Map<string, Event[]>();
  for (const e of dead) {
    if (e.resume === null) continue;
    if (e.source === "approval_answer") {
      const callId = answerCallId(e.payload);
      if (callId !== null && t.getSession(e.resume)?.pending === callId) {
        // The answer died before resolveAnswer settled the call; release the deferral so the session does not stay paused.
        t.deleteDeferred(callId);
        t.cancelApprovalRequest(callId);
        t.setSessionPending(e.resume, null);
        t.cancelFollowUp(expiryTimerId(callId), e.resume);
      }
    }
    bySession.set(e.resume, [...(bySession.get(e.resume) ?? []), e]);
  }
  for (const [sessionId, events] of bySession) {
    const oldest = events[0]!;
    const lines = ["This task stopped after repeated failures and will not be retried on its own."];
    if (error) {
      const shown = error.length > DEAD_ERROR_LIMIT ? `${error.slice(0, DEAD_ERROR_LIMIT)}…` : error;
      lines.push("", `The last error was: ${shown}`);
    }
    t.insertOutMsg({
      id: crypto.randomUUID(),
      inboxId,
      sessionId,
      thread: t.primaryThread(sessionId),
      kind: "message",
      body: lines.join("\n"),
      callId: null,
      dedupeKey: `${DEAD_NOTICE_PREFIX}${sessionId}:${oldest.id}`,
      createdAt: now,
      // Owned by the run that died, so the session's next run does not count it as its own message.
      ...(oldest.run === null ? {} : { runId: oldest.run }),
    });
  }
}

export type DispatcherOptions = {
  store: Store;
  clock: Clock;
  inboxId: InboxId;
  channel: Channel;
  policy?: RatePolicy;
  crash?: CrashHook;
};

export type DispatchResult = {
  delivered: number;
  /** When a held or backed-off message could go; null if nothing is waiting. */
  nextCheckAt: number | null;
};

/**
 * Delivers the outbox through the channel (spec §7.4). Messages of one session go out in order:
 * a later one waits while an earlier one is undelivered. A `failed` message no longer counts as undelivered,
 * so a message that will never go out does not mute the rest of its session.
 */
export class Dispatcher {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly inboxId: InboxId;
  private readonly channel: Channel;
  private readonly policy: RatePolicy;
  private readonly crashHook: CrashHook;
  private crashed: SimulatedCrash | null = null;
  private stopped = true;
  private woken = false;
  private wakeUp: (() => void) | null = null;

  constructor(o: DispatcherOptions) {
    this.store = o.store;
    this.clock = o.clock;
    this.inboxId = o.inboxId;
    this.channel = o.channel;
    this.policy = o.policy ?? DEFAULT_RATE_POLICY;
    this.crashHook = o.crash ?? (() => {});
  }

  async pass(): Promise<DispatchResult> {
    this.assertAlive();
    const now = this.clock.now();
    const { due, retryAt, recentSent } = this.store.tx((t) => {
      // Only one dispatcher serves an inbox, so `sending` here means a delivery whose outcome died with its process.
      // The channel dedupes by key, so trying it again is safe (I-OUT-2).
      t.resetSending(this.inboxId);
      const heads = new Map<string, { msg: OutMsg; nextAttemptAt: number }>();
      for (const q of t.listUndelivered(this.inboxId)) if (!heads.has(q.msg.sessionId)) heads.set(q.msg.sessionId, q);
      const queued = [...heads.values()];
      const waiting = queued.filter((q) => q.nextAttemptAt > now).map((q) => q.nextAttemptAt);
      return {
        due: queued.filter((q) => q.nextAttemptAt <= now).map((q) => q.msg),
        retryAt: waiting.length > 0 ? Math.min(...waiting) : null,
        recentSent: t.listSentTimes(this.inboxId, now - Math.max(this.policy.windowMs, this.policy.minIntervalMs)),
      };
    });

    const plan = pace(due, recentSent, now, this.policy);
    let delivered = 0;
    let failedAt: number | null = null;
    for (const m of plan.send) {
      const next = await this.deliver(m);
      if (next === "sent") delivered++;
      else if (next !== null) failedAt = failedAt === null ? next : Math.min(failedAt, next);
    }
    // A delivery can unblock the next message of its session, so look again right away.
    const candidates = [retryAt, plan.nextCheckAt, failedAt, delivered > 0 ? now : null].filter((x) => x !== null);
    return { delivered, nextCheckAt: candidates.length > 0 ? Math.min(...candidates) : null };
  }

  /** Passes until `stop()`, sleeping until the next check but never longer than `DISPATCHER_MAX_SLEEP_MS`. */
  async serve(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      this.woken = false;
      const { nextCheckAt } = await this.pass();
      if (this.stopped || this.woken) continue;
      const delay = nextCheckAt === null ? DISPATCHER_MAX_SLEEP_MS : nextCheckAt - this.clock.now();
      if (delay <= 0) continue;
      await this.sleep(Math.min(delay, DISPATCHER_MAX_SLEEP_MS));
    }
  }

  /** A hint that the outbox may have new messages. */
  wake(): void {
    this.woken = true;
    this.wakeUp?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake();
  }

  private sleep(ms: number): Promise<void> {
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

  /** Returns "sent", the time of the next attempt after a failure, or null if it failed for good or was not pending. */
  private async deliver(m: OutMsg): Promise<"sent" | number | null> {
    if (!this.store.tx((t) => t.markSending(m.id))) return null;
    try {
      await this.channel.deliver({ ...m, status: "sending" });
    } catch {
      this.assertAlive();
      const attempts = m.attempts + 1;
      const next = attempts >= OUTBOX_MAX_ATTEMPTS ? null : this.clock.now() + 2 ** (attempts - 1) * MINUTE;
      this.store.tx((t) => t.markDeliveryFailed(m.id, next));
      return next;
    }
    this.crashAt("after_deliver");
    // Still `sent` if the message was cancelled mid-delivery: it did reach the user.
    this.store.tx((t) => t.markSent(m.id, this.clock.now()));
    return "sent";
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
