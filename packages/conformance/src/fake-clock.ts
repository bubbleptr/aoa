import type { Clock } from "./kernel.ts";

type Timer = { due: number; seq: number; fn: () => void };

/** Time moves only when a test calls `advance`; due timers fire in order during it. */
export class FakeClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private seq = 0;
  private onTimer: (() => void)[] = [];

  constructor(start = Date.UTC(2026, 10, 16)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const timer = { due: this.current + ms, seq: this.seq++, fn };
    this.timers.push(timer);
    for (const resolve of this.onTimer.splice(0)) resolve();
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** Resolves once some timer is pending, e.g. when a worker has gone to sleep until a known time. */
  timerPending(): Promise<void> {
    if (this.timers.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.onTimer.push(resolve));
  }

  /** Resolves once a pending timer is due at or before `at`, e.g. a worker's sleep until the next retry. */
  async timerDueBy(at: number): Promise<void> {
    while (!this.timers.some((t) => t.due <= at)) {
      await new Promise<void>((resolve) => this.onTimer.push(resolve));
    }
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const next = this.timers
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.current = next.due;
      next.fn();
    }
    this.current = target;
  }
}
