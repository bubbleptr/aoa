import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Scheduler,
  SimulatedCrash,
  Worker,
  appendEvent,
  type AppendResult,
  type CrashHook,
  type CrashPoint,
  type NewEvent,
  type Store,
  type WorkerOptions,
} from "@aoa/kernel";
import { sqliteStore } from "@aoa/store-sqlite";
import { FakeClock } from "./fake-clock.ts";

/** One database per test. `connect` opens another connection to it, as a second process would. */
export type TestDatabase = { connect(): Store; dispose(): void };

export type StoreFactory = () => TestDatabase;

export const sqliteFactory: StoreFactory = () => {
  const dir = mkdtempSync(join(tmpdir(), "aoa-conformance-"));
  const opened: { close(): void }[] = [];
  return {
    connect() {
      const store = sqliteStore(join(dir, "aoa.db"));
      opened.push(store);
      return store;
    },
    dispose() {
      for (const s of opened) s.close();
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
  readonly store: Store;
  private seq = 0;

  constructor(private readonly db: TestDatabase) {
    this.store = db.connect();
  }

  connect(): Store {
    return this.db.connect();
  }

  dispose(): void {
    this.db.dispose();
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
