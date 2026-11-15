import type { Channel, NewEvent, OutMsg } from "@aoa/kernel";

export type DeliveryFailure = "before_accept" | "after_accept";

/**
 * A channel that behaves like a well-behaved remote: it shows each `dedupeKey` to the user once,
 * however often `deliver` is called. Tests script failures and feed inbound events.
 */
export class FakeChannel implements Channel {
  readonly calls: OutMsg[] = [];
  /** What the user sees, in order. */
  readonly visible: OutMsg[] = [];
  readonly polls: (string | null)[] = [];
  private failures: DeliveryFailure[] = [];
  private feed: NewEvent[] = [];
  private waiters: { count: number; resolve: () => void }[] = [];

  /** The next deliveries fail in this order; `after_accept` means the remote showed it, then the call errored. */
  failNext(...failures: DeliveryFailure[]): void {
    this.failures.push(...failures);
  }

  /** Events the remote holds; `poll` returns the ones after the cursor. */
  push(...events: NewEvent[]): void {
    this.feed.push(...events);
  }

  async deliver(m: OutMsg): Promise<void> {
    this.calls.push(m);
    const failure = this.failures.shift();
    if (failure === "before_accept") throw new Error("connection refused");
    if (!this.visible.some((v) => v.dedupeKey === m.dedupeKey)) {
      this.visible.push(m);
      for (const w of this.waiters.filter((w) => this.visible.length >= w.count)) w.resolve();
    }
    if (failure === "after_accept") throw new Error("timed out waiting for the response");
  }

  /** Resolves once the user has seen `count` messages. */
  seen(count: number): Promise<void> {
    if (this.visible.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  async poll(cursor: string | null): Promise<{ events: NewEvent[]; cursor: string }> {
    this.polls.push(cursor);
    const from = cursor === null ? 0 : Number(cursor);
    return { events: this.feed.slice(from), cursor: String(this.feed.length) };
  }
}
