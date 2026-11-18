import type { Channel } from "./channel.ts";
import { SimulatedCrash, type CrashHook } from "./crash.ts";
import { appendInTx } from "./intake.ts";
import type { Clock, Store } from "./ports.ts";
import type { InboxId } from "./types.ts";

/** How often the poller asks the channel for new events (POLL_INTERVAL, design §9). */
export const POLL_INTERVAL_MS = 60_000;

export type ChannelPollerOptions = {
  store: Store;
  clock: Clock;
  inboxId: InboxId;
  channel: Pick<Required<Channel>, "poll">;
  /** Names the cursor, for an inbox fed by more than one channel. */
  name?: string;
  intervalMs?: number;
  crash?: CrashHook;
  /** Called after a pass that accepted at least one event; the caller wakes the worker. */
  onEvents?: () => void;
};

/** The handler for a channel without push: polls it and appends what it returns (design §5, "事件源"). */
export class ChannelPoller {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly inboxId: InboxId;
  private readonly channel: Pick<Required<Channel>, "poll">;
  private readonly name: string;
  private readonly intervalMs: number;
  private readonly crashHook: CrashHook;
  private readonly onEvents: () => void;
  private crashed: SimulatedCrash | null = null;
  private stopped = true;
  private wakeUp: (() => void) | null = null;

  constructor(o: ChannelPollerOptions) {
    this.store = o.store;
    this.clock = o.clock;
    this.inboxId = o.inboxId;
    this.channel = o.channel;
    this.name = o.name ?? "channel";
    this.intervalMs = o.intervalMs ?? POLL_INTERVAL_MS;
    this.crashHook = o.crash ?? (() => {});
    this.onEvents = o.onEvents ?? (() => {});
  }

  /**
   * One poll. The events and the new cursor are stored in one transaction, so a crash in between
   * only repeats the poll, and the repeated events are dropped by their dedupe keys.
   */
  async pass(): Promise<{ accepted: number }> {
    if (this.crashed) throw this.crashed;
    const cursor = this.store.tx((t) => t.getCursor(this.inboxId, this.name));
    const polled = await this.channel.poll(cursor);
    try {
      this.crashHook("after_poll");
    } catch (err) {
      if (err instanceof SimulatedCrash) this.crashed = err;
      throw err;
    }
    const accepted = this.store.tx((t) => {
      const now = this.clock.now();
      let n = 0;
      for (const e of polled.events) if (appendInTx(t, this.inboxId, now, e).status === "pending") n++;
      t.setCursor(this.inboxId, this.name, polled.cursor);
      return n;
    });
    if (accepted > 0) this.onEvents();
    return { accepted };
  }

  /** Polls every `intervalMs` until `stop()`. */
  async serve(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      await this.pass();
      await this.sleep(this.intervalMs);
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
}
