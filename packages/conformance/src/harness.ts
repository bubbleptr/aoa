import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelPoller,
  Dispatcher,
  LEASE_MS,
  Scheduler,
  SimulatedCrash,
  Worker,
  appendEvent,
  retryDelayMs,
  type AppendResult,
  type CrashHook,
  type CrashPoint,
  type Channel,
  type RatePolicy,
  type NewEvent,
  type Store,
  type WorkerOptions,
} from "./kernel.ts";
import { sqliteStore } from "@aoa-dev/sdk";
import { FakeClock } from "./fake-clock.ts";

/** One database per test. `connect` opens another connection to it, as a second process would. */
export type TestDatabase = {
  connect(): Store;
  /** Closes every connection, as a process exit would; the data stays. */
  closeAll(): void;
  dispose(): void;
};

export type StoreFactory = () => TestDatabase;

export const sqliteFactory: StoreFactory = () => {
  const dir = mkdtempSync(join(tmpdir(), "aoa-conformance-"));
  const opened: { close(): void }[] = [];
  const closeAll = () => {
    for (const s of opened.splice(0)) s.close();
  };
  return {
    connect() {
      const store = sqliteStore(join(dir, "aoa.db"));
      opened.push(store);
      return store;
    },
    closeAll,
    dispose() {
      closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export const storeFactories: [string, StoreFactory][] = [["sqlite", sqliteFactory]];

/** A hook that crashes at `point` the first `times` times it is reached. */
export function crashAt(point: CrashPoint, times = 1): CrashHook {
  let left = times;
  return (p) => {
    if (p === point && left > 0) {
      left--;
      throw new SimulatedCrash(p);
    }
  };
}

export type WorkerSetup = Omit<WorkerOptions, "store" | "clock" | "inboxId"> & { store?: Store };

export class Harness {
  readonly clock = new FakeClock();
  readonly inboxId = "inbox-1";
  store: Store;
  /** A directory that outlives `restart`, for memory. */
  readonly memoryDir: string;
  private seq = 0;

  constructor(private readonly db: TestDatabase) {
    this.store = db.connect();
    this.memoryDir = mkdtempSync(join(tmpdir(), "aoa-memory-"));
  }

  /** Closes every connection and opens a fresh one, as a restarted process would. */
  restart(): void {
    this.db.closeAll();
    this.store = this.db.connect();
  }

  /** Moves the clock past a dead worker's lease and the retry delay after its `attempts`-th failure (design §9). */
  waitOutLease(attempts = 1): void {
    this.clock.advance(LEASE_MS + retryDelayMs(attempts));
  }

  connect(): Store {
    return this.db.connect();
  }

  dispose(): void {
    this.db.dispose();
    rmSync(this.memoryDir, { recursive: true, force: true });
  }

  /** Appends a trusted user message unless `e` says otherwise; dedupe keys are unique by default. */
  append(e: Partial<NewEvent> = {}): AppendResult {
    return appendEvent(
      { store: this.store, clock: this.clock, inboxId: this.inboxId },
      { source: "user_message", dedupeKey: `msg-${++this.seq}`, payload: { text: `message ${this.seq}` }, trusted: true, ...e },
    );
  }

  scheduler(o: { store?: Store; crash?: CrashHook; onFire?: () => void } = {}): Scheduler {
    return new Scheduler({ store: o.store ?? this.store, clock: this.clock, inboxId: this.inboxId, ...o });
  }

  dispatcher(o: { channel: Channel; store?: Store; crash?: CrashHook; policy?: RatePolicy }): Dispatcher {
    return new Dispatcher({ store: o.store ?? this.store, clock: this.clock, inboxId: this.inboxId, ...o });
  }

  poller(o: { channel: Pick<Required<Channel>, "poll">; store?: Store; crash?: CrashHook; onEvents?: () => void }): ChannelPoller {
    return new ChannelPoller({ store: o.store ?? this.store, clock: this.clock, inboxId: this.inboxId, ...o });
  }

  outbox() {
    return this.store.tx((t) => t.listOutbox(this.inboxId));
  }

  timerEvents() {
    return this.events().filter((e) => e.source === "timer");
  }

  worker(o: WorkerSetup): Worker {
    return new Worker({ store: o.store ?? this.store, clock: this.clock, inboxId: this.inboxId, ...o });
  }

  events() {
    return this.store.tx((t) => t.listEvents(this.inboxId));
  }

  runs() {
    return this.store.tx((t) => t.listRuns(this.inboxId));
  }
}
