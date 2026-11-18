import type { Channel, NewEvent, OutMsg } from "@aoa-dev/kernel";

export type DeliveryFailure = "before_accept" | "after_accept";

/** Controls for a delivery the test holds in flight with `holdNext()`; it ends when the test releases or fails it. */
export type HeldDelivery = {
  /** Resolves once `deliver` has been called and is waiting. */
  started: Promise<void>;
  release(): void;
  fail(err?: Error): void;
};

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
  private held: (Omit<HeldDelivery, "started"> & { promise: Promise<void>; started: () => void }) | null = null;

  /** The next deliveries fail in this order; `after_accept` means the remote showed it, then the call errored. */
  failNext(...failures: DeliveryFailure[]): void {
    this.failures.push(...failures);
  }

  /** Events the remote holds; `poll` returns the ones after the cursor. */
  push(...events: NewEvent[]): void {
    this.feed.push(...events);
  }

  /**
   * Makes the next `deliver` wait until the test calls `release()` or `fail()`, so a test can act while
   * the delivery is in flight. What happens afterwards is an ordinary delivery, including `failures`.
   */
  holdNext(): HeldDelivery {
    let started = () => {};
    const start = new Promise<void>((resolve) => (started = resolve));
    let resolve = () => {};
    let reject = (_err: Error) => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const fail = (err?: Error) => reject(err ?? new Error("connection refused"));
    this.held = { promise, started, release: resolve, fail };
    return { started: start, release: resolve, fail };
  }

  async deliver(m: OutMsg): Promise<void> {
    const held = this.held;
    if (held) {
      this.held = null;
      held.started();
      await held.promise;
    }
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
