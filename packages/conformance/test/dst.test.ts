import { describe, expect, test } from "bun:test";
import {
  hashSeed,
  runServeSimulation,
  runSimulation,
  storeFactories,
  type FaultStats,
} from "../src/index.ts";

function parseSeedEnv(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed) >>> 0;
  return hashSeed(trimmed);
}

function parsePositiveIntEnv(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const ENV_SEED = parseSeedEnv(process.env.AOA_DST_SEED);
const ENV_SEEDS = parsePositiveIntEnv(process.env.AOA_DST_SEEDS);
const ENV_STEPS = parsePositiveIntEnv(process.env.AOA_DST_STEPS);

function seedsForCampaign(baseOffset: number, defaultCount: number): number[] {
  if (ENV_SEED !== null) return [ENV_SEED];
  const count = ENV_SEEDS ?? defaultCount;
  return Array.from({ length: count }, (_, i) => (baseOffset + i) >>> 0);
}

function addStats(acc: FaultStats, next: FaultStats): void {
  for (const key of Object.keys(acc) as (keyof FaultStats)[]) {
    acc[key] += next[key];
  }
}

function zeroStats(): FaultStats {
  return {
    after_append: 0,
    after_claim: 0,
    after_tool_exec: 0,
    after_tool_result: 0,
    before_complete: 0,
    after_timer_fire: 0,
    after_deliver: 0,
    after_poll: 0,
    runtimeFailures: 0,
    stopAborts: 0,
    competingDrains: 0,
    leaseExpirations: 0,
    leaseRenewals: 0,
    channelBeforeAccept: 0,
    channelAfterAccept: 0,
    heldDeliveries: 0,
    deadEvents: 0,
    deferredCreated: 0,
    deferredApproved: 0,
    deferredDenied: 0,
    deferredExpired: 0,
    admitHeld: 0,
    sessionsClosed: 0,
    restarts: 0,
  };
}

for (const [name, storeFactory] of storeFactories) {
  describe(`deterministic simulation testing [${name}]`, () => {
    test(
      "deterministic replay produces identical trace, stats, events, and visible messages",
      async () => {
        const seed = ENV_SEED ?? 4242;
        const steps = ENV_STEPS ?? 60;

        for (const mode of ["kernel", "harness"] as const) {
          const r1 = await runSimulation({ seed, steps, mode, storeFactory });
          const r2 = await runSimulation({ seed, steps, mode, storeFactory });
          expect(r1.trace).toEqual(r2.trace);
          expect(r1.stats).toEqual(r2.stats);
          expect(r1.finalEvents).toEqual(r2.finalEvents);
          expect(r1.visibleMessages).toEqual(r2.visibleMessages);
          expect(r1.harnessExecutions).toEqual(r2.harnessExecutions);
        }
      },
      60_000,
    );

    test(
      "kernel-mode multi-seed fuzzing preserves all invariants and reaches fault coverage",
      async () => {
        const defaultCount = 25;
        const seeds = seedsForCampaign(1000, defaultCount);
        const steps = ENV_STEPS ?? 80;
        const total = zeroStats();

        for (const seed of seeds) {
          const res = await runSimulation({
            seed,
            steps,
            mode: "kernel",
            storeFactory,
            faultProfile: "standard",
            ...(seed % 3 === 0 ? { debounceMs: 1_500 } : {}),
          });
          addStats(total, res.stats);
        }

        if (ENV_SEED === null && (ENV_SEEDS === null || ENV_SEEDS >= defaultCount)) {
          expect(total.after_claim).toBeGreaterThan(0);
          expect(total.after_tool_exec).toBeGreaterThan(0);
          expect(total.after_tool_result).toBeGreaterThan(0);
          expect(total.before_complete).toBeGreaterThan(0);
          expect(total.after_timer_fire).toBeGreaterThan(0);
          expect(total.after_deliver).toBeGreaterThan(0);
          expect(total.after_poll).toBeGreaterThan(0);
          expect(total.runtimeFailures).toBeGreaterThan(0);
          expect(total.stopAborts).toBeGreaterThan(0);
          expect(total.competingDrains).toBeGreaterThan(0);
          expect(total.deadEvents).toBeGreaterThan(0);
          expect(total.deferredApproved).toBeGreaterThan(0);
          expect(total.deferredDenied).toBeGreaterThan(0);
          expect(total.deferredExpired).toBeGreaterThan(0);
          expect(total.sessionsClosed).toBeGreaterThan(0);
          expect(total.restarts).toBeGreaterThan(0);
        }
      },
      120_000,
    );

    test(
      "harness-mode multi-seed fuzzing enforces admit holds, grants, and deferrals",
      async () => {
        const defaultCount = 20;
        const seeds = seedsForCampaign(2000, defaultCount);
        const steps = ENV_STEPS ?? 70;
        const total = zeroStats();
        let totalHarnessExecutions = 0;

        for (const seed of seeds) {
          const res = await runSimulation({
            seed,
            steps,
            mode: "harness",
            storeFactory,
            faultProfile: "standard",
          });
          addStats(total, res.stats);
          totalHarnessExecutions += res.harnessExecutions;
        }

        if (ENV_SEED === null && (ENV_SEEDS === null || ENV_SEEDS >= defaultCount)) {
          expect(total.admitHeld).toBeGreaterThan(0);
          expect(total.deferredApproved).toBeGreaterThan(0);
          expect(total.deferredDenied).toBeGreaterThan(0);
          expect(total.deferredExpired).toBeGreaterThan(0);
          expect(totalHarnessExecutions).toBeGreaterThan(0);
        }
      },
      120_000,
    );

    test(
      "high-chaos fault storm preserves invariants under heavy crashes and restarts",
      async () => {
        const seeds = seedsForCampaign(3000, 15);
        const steps = ENV_STEPS ?? 70;
        const total = zeroStats();

        for (const seed of seeds) {
          const mode = seed % 2 === 0 ? "kernel" : "harness";
          const res = await runSimulation({
            seed,
            steps,
            mode,
            storeFactory,
            faultProfile: "chaos",
          });
          addStats(total, res.stats);
        }

        if (ENV_SEED === null && (ENV_SEEDS === null || ENV_SEEDS >= 15)) {
          expect(total.restarts).toBeGreaterThan(0);
          expect(total.after_claim + total.before_complete).toBeGreaterThan(0);
        }
      },
      120_000,
    );

    test(
      "concurrent serve() loops converge cleanly to quiescence",
      async () => {
        const seeds = seedsForCampaign(4000, 10);
        const steps = ENV_STEPS ?? 40;
        const total = zeroStats();

        for (const seed of seeds) {
          const mode = seed % 2 === 0 ? "kernel" : "harness";
          const res = await runServeSimulation({
            seed,
            steps,
            mode,
            storeFactory,
          });
          addStats(total, res.stats);
        }

        if (ENV_SEED === null && (ENV_SEEDS === null || ENV_SEEDS >= 10)) {
          expect(total.restarts).toBeGreaterThan(0);
        }
      },
      120_000,
    );
  });
}
