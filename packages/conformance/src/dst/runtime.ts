import type {
  AgentRuntime,
  Ask,
  CallId,
  EventId,
  RunId,
  RunInput,
  RunResult,
  SessionId,
  TimerId,
  Tool,
  ToolDef,
} from "../kernel.ts";
import { Prng } from "./prng.ts";

export type EffectLog = {
  nonIdempotentCounts: Map<string, number>;
  idempotentCounts: Map<string, number>;
  kernelExecutions: { sessionId: SessionId; callId: CallId; tool: string; args: unknown; idempotent: boolean }[];
  harnessExecutions: { sessionId: SessionId; callId: CallId; tool: string; args: unknown }[];
  maxActive: number;
  activeSessions: Set<SessionId>;
  callbackViolations: string[];
};

export function createEffectLog(): EffectLog {
  return {
    nonIdempotentCounts: new Map(),
    idempotentCounts: new Map(),
    kernelExecutions: [],
    harnessExecutions: [],
    maxActive: 0,
    activeSessions: new Set(),
    callbackViolations: [],
  };
}

function makeKernelTool(
  effects: EffectLog,
  name: string,
  risk: "low" | "medium" | "high",
  idempotent: boolean,
): ToolDef {
  const counts = idempotent ? effects.idempotentCounts : effects.nonIdempotentCounts;
  return {
    name,
    description: `DST deterministic tool ${name}`,
    schema: {
      type: "object",
      properties: { tag: { type: "string" } },
    },
    risk,
    idempotent,
    async execute(args, ctx) {
      const key = `${ctx.sessionId}:${ctx.callId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      effects.kernelExecutions.push({
        sessionId: ctx.sessionId,
        callId: ctx.callId,
        tool: name,
        args,
        idempotent,
      });
      return { ok: true, tool: name, callId: ctx.callId };
    },
  };
}

/** Creates the 5 custom tools used by the DST runtime to track idempotency and risk tiers. */
export function createDstTools(
  effects: EffectLog,
  opts?: { onSlowTool?: (signal: AbortSignal) => Promise<void> | null },
): ToolDef[] {
  const flakyTool: ToolDef = {
    name: "flaky_tool",
    description: "DST tool supporting slow execution and simulated failures",
    schema: {
      type: "object",
      properties: {
        tag: { type: "string" },
        slow: { type: "boolean" },
        shouldThrow: { type: "boolean" },
      },
    },
    risk: "low",
    idempotent: false,
    async execute(raw, ctx) {
      const args = (raw ?? {}) as { slow?: unknown; shouldThrow?: unknown };
      if (args.slow === true && opts?.onSlowTool) {
        const pending = opts.onSlowTool(ctx.signal);
        if (pending) {
          await pending;
          ctx.signal.throwIfAborted();
        }
      }
      if (args.shouldThrow === true) {
        throw new Error("tool failed");
      }
      const key = `${ctx.sessionId}:${ctx.callId}`;
      effects.nonIdempotentCounts.set(key, (effects.nonIdempotentCounts.get(key) ?? 0) + 1);
      effects.kernelExecutions.push({
        sessionId: ctx.sessionId,
        callId: ctx.callId,
        tool: "flaky_tool",
        args: raw,
        idempotent: false,
      });
      return { ok: true, tool: "flaky_tool", callId: ctx.callId };
    },
  };

  return [
    makeKernelTool(effects, "effect_low", "low", false),
    makeKernelTool(effects, "effect_med", "medium", false),
    makeKernelTool(effects, "effect_high", "high", false),
    makeKernelTool(effects, "idem_low", "low", true),
    flakyTool,
  ];
}

export type NextRunDirective = {
  failAfterCalls?: boolean;
  hangAfterCalls?: boolean;
  holdGate?: Promise<void>;
  quiet?: boolean;
};

type PlannedCall =
  | { kind: "kernel"; callId: CallId; tool: string; args: unknown }
  | { kind: "harness"; callId: CallId; tool: string; args: unknown; reason?: string };

type TurnPlan = {
  calls: PlannedCall[];
  extraAfterDefer: PlannedCall | null;
  initiated: Set<CallId>;
};

export type ObservedDstRun = {
  runId: RunId;
  sessionId: SessionId;
  eventIds: EventId[];
  resumed: boolean;
  hadAnswer: boolean;
};

const ADVERSARIAL_MEMORY_PATHS = [
  "instructions.md",
  "Instructions.MD",
  "notes/../instructions.md",
] as const;

const KERNEL_TOOL_CANDIDATES = [
  "effect_low",
  "effect_med",
  "effect_high",
  "idem_low",
  "flaky_tool",
  "notify",
  "wake_me_at",
  "cancel_wake",
  "follow",
  "ask_user",
  "memory_read",
  "memory_write",
  "memory_list",
  "memory_delete",
] as const;

const HARNESS_KERNEL_TOOLS = [
  "notify",
  "wake_me_at",
  "cancel_wake",
  "follow",
  "memory_read",
  "memory_write",
  "memory_list",
  "memory_delete",
  "ask_user",
] as const;

/**
 * Deterministic fault-injecting runtime for DST in both kernel (tier 1) and harness (tier 2) modes.
 * Plans are derived and cached per turn key so retries replay identical call IDs and arguments.
 */
export class DstRuntime {
  readonly kind: "kernel" | "harness";
  readonly effects: EffectLog;
  quiescing = false;
  readonly runs: ObservedDstRun[] = [];

  private readonly prng: Prng;
  private readonly directives: NextRunDirective[] = [];
  private readonly turnPlans = new Map<string, TurnPlan>();
  private readonly sessionTimers = new Map<SessionId, TimerId[]>();
  private readonly answeredCallIds = new Set<CallId>();
  private active = 0;
  private waiters: { count: number; resolve: () => void }[] = [];

  constructor(prng: Prng, effects: EffectLog, opts?: { kind?: "kernel" | "harness" }) {
    this.prng = prng;
    this.effects = effects;
    this.kind = opts?.kind ?? "kernel";
  }

  /** Queues a one-shot directive consumed FIFO by subsequent `run()` calls. */
  pushDirective(d: NextRunDirective): void {
    this.directives.push(d);
  }

  /** Resolves once at least `count` runs have started. */
  started(count: number): Promise<void> {
    if (this.runs.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve });
      this.notify();
    });
  }

  /** Returns a view typed as `AgentRuntime` for `WorkerOptions.runtime`. */
  asRuntime(): AgentRuntime {
    return this;
  }

  async run(input: RunInput & { ask?: Ask }): Promise<RunResult> {
    const directive = this.directives.shift();
    this.runs.push({
      runId: input.runId,
      sessionId: input.session.id,
      eventIds: input.events.map((e) => e.id),
      resumed: input.session.resumed,
      hadAnswer: input.answer !== undefined,
    });

    let turnIndex = 0;
    for (const r of this.runs) {
      if (r.sessionId === input.session.id) turnIndex++;
    }

    this.active++;
    const concurrent = Math.max(this.active, this.effects.activeSessions.size + 1);
    this.effects.maxActive = Math.max(this.effects.maxActive, concurrent);
    if (this.active > 1 || this.effects.activeSessions.size > 0) {
      this.effects.callbackViolations.push(
        `concurrent run detected: active=${this.active}, activeSessions=${this.effects.activeSessions.size}, session=${input.session.id}, run=${input.runId}`,
      );
    }
    const addedSession = !this.effects.activeSessions.has(input.session.id);
    this.effects.activeSessions.add(input.session.id);
    this.notify();

    try {
      if (input.answer) {
        this.answeredCallIds.add(input.answer.callId);
      }

      if (directive?.holdGate) {
        await directive.holdGate;
      }
      if (input.signal.aborted) {
        throw input.signal.reason ?? new Error("aborted");
      }

      const turnKey = `${input.session.id}:${input.events[0]?.id ?? input.runId}`;
      const cachedPlan = this.turnPlans.get(turnKey);

      if (directive?.quiet) {
        await this.afterCalls(directive, input.signal);
        return { end: { kind: "silent" }, sessionRef: `ref:${input.session.id}:${turnIndex}` };
      }

      if (
        this.kind === "harness" &&
        input.answer?.verdict === "approve" &&
        input.answer.tool.startsWith("harness_")
      ) {
        if (!input.ask) throw new Error("harness runtime requires input.ask");
        input.emit?.({ kind: "reasoning", delta: `replay approved ${input.answer.tool}` });
        input.emit?.({ kind: "text", delta: `executing ${input.answer.tool}` });
        const useCallId = `${input.answer.callId}:use`;
        const verdict = await input.ask({
          callId: useCallId,
          tool: input.answer.tool,
          args: input.answer.args,
        });
        if (verdict === "allow") {
          input.emit?.({
            kind: "tool_start",
            callId: useCallId,
            tool: input.answer.tool,
            args: input.answer.args,
          });
          this.effects.harnessExecutions.push({
            sessionId: input.session.id,
            callId: useCallId,
            tool: input.answer.tool,
            args: input.answer.args,
          });
          input.emit?.({
            kind: "tool_end",
            callId: useCallId,
            result: { status: "ok", output: { ok: true, tool: input.answer.tool } },
          });
        }
        await this.afterCalls(directive, input.signal);
        return { end: { kind: "silent" }, sessionRef: `ref:${input.session.id}:${turnIndex}` };
      }

      if (this.quiescing && !cachedPlan) {
        input.emit?.({ kind: "text", delta: `quiescing ${input.session.id}` });
        await this.afterCalls(directive, input.signal);
        return { end: { kind: "silent" }, sessionRef: `ref:${input.session.id}` };
      }

      input.emit?.({ kind: "reasoning", delta: `plan ${turnKey}` });
      input.emit?.({ kind: "text", delta: `turn ${turnKey}` });

      let plan = cachedPlan;
      if (!plan) {
        plan = this.buildTurnPlan(turnKey, input);
        this.turnPlans.set(turnKey, plan);
      }

      await this.executePlan(plan, input, this.quiescing);
      await this.afterCalls(directive, input.signal);
      return { end: { kind: "silent" }, sessionRef: `ref:${input.session.id}:${turnIndex}` };
    } finally {
      this.active--;
      if (addedSession) {
        this.effects.activeSessions.delete(input.session.id);
      }
    }
  }

  private async afterCalls(directive: NextRunDirective | undefined, signal: AbortSignal): Promise<void> {
    if (directive?.hangAfterCalls) {
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (directive?.failAfterCalls) {
      throw new Error("simulated model failure");
    }
  }

  private buildTurnPlan(turnKey: string, input: RunInput): TurnPlan {
    const turnPrng = this.prng.fork(turnKey);
    const toolMap = new Map<string, Tool>(input.tools.map((t) => [t.name, t]));
    const calls: PlannedCall[] = [];

    if (this.kind === "kernel") {
      const available = KERNEL_TOOL_CANDIDATES.filter((name) => {
        if (!toolMap.has(name)) return false;
        if (name === "cancel_wake") {
          const known = this.sessionTimers.get(input.session.id);
          return (known?.length ?? 0) > 0;
        }
        return true;
      });
      if (available.length > 0) {
        const count = turnPrng.weighted([
          { weight: 1, value: 0 },
          { weight: 3, value: 1 },
          { weight: 4, value: 2 },
          { weight: 2, value: 3 },
        ]);
        for (let i = 0; i < count; i++) {
          const toolName = turnPrng.pick(available);
          const callId = `${turnKey}:c${i}`;
          calls.push({
            kind: "kernel",
            callId,
            tool: toolName,
            args: this.buildKernelArgs(turnPrng, toolName, input.session.id, turnKey, i),
          });
        }
      }
      const extraCandidates = available.filter((n) => n !== "wake_me_at" && n !== "cancel_wake");
      const probePool = extraCandidates.length > 0 ? extraCandidates : available;
      let extraAfterDefer: PlannedCall | null = null;
      if (probePool.length > 0 && turnPrng.bool(0.25)) {
        const extraTool = turnPrng.pick(probePool);
        extraAfterDefer = {
          kind: "kernel",
          callId: `${turnKey}:extra`,
          tool: extraTool,
          args: this.buildKernelArgs(turnPrng, extraTool, input.session.id, turnKey, 99),
        };
      }
      return { calls, extraAfterDefer, initiated: new Set() };
    }

    const availableKernel = HARNESS_KERNEL_TOOLS.filter((name) => {
      if (!toolMap.has(name)) return false;
      if (name === "cancel_wake") {
        const known = this.sessionTimers.get(input.session.id);
        return (known?.length ?? 0) > 0;
      }
      return true;
    });
    const count = turnPrng.weighted([
      { weight: 1, value: 0 },
      { weight: 4, value: 1 },
      { weight: 3, value: 2 },
      { weight: 2, value: 3 },
    ]);
    for (let i = 0; i < count; i++) {
      const useHarness = availableKernel.length === 0 || turnPrng.bool(0.6);
      if (useHarness) {
        calls.push(this.buildHarnessCall(turnPrng, input, turnKey, `${turnKey}:h${i}`, i));
      } else {
        const toolName = turnPrng.pick(availableKernel);
        calls.push({
          kind: "kernel",
          callId: `${turnKey}:c${i}`,
          tool: toolName,
          args: this.buildKernelArgs(turnPrng, toolName, input.session.id, turnKey, i),
        });
      }
    }

    const extraAfterDefer = turnPrng.bool(0.2)
      ? this.buildHarnessCall(turnPrng, input, turnKey, `${turnKey}:h_extra`, 99)
      : null;

    return { calls, extraAfterDefer, initiated: new Set() };
  }

  private buildHarnessCall(
    turnPrng: Prng,
    input: RunInput,
    turnKey: string,
    callId: CallId,
    index: number,
  ): PlannedCall {
    const tool = turnPrng.pick(["harness_bash", "harness_edit"] as const);
    const reason = turnPrng.bool(0.5) ? `need ${tool} at ${turnKey}:${index}` : undefined;
    if (tool === "harness_bash") {
      return {
        kind: "harness",
        callId,
        tool,
        args: {
          command: turnPrng.pick(["ls -la", "git status", "bun test"]),
          cwd: input.session.workdir ?? "/work",
        },
        ...(reason ? { reason } : {}),
      };
    }
    return {
      kind: "harness",
      callId,
      tool,
      args: {
        path: turnPrng.pick(["src/index.ts", "README.md", "notes.txt"]),
        summary: `edit ${turnKey}:${index}`,
      },
      ...(reason ? { reason } : {}),
    };
  }

  private buildKernelArgs(
    turnPrng: Prng,
    toolName: string,
    sessionId: SessionId,
    turnKey: string,
    index: number,
  ): unknown {
    switch (toolName) {
      case "effect_low":
      case "effect_med":
      case "effect_high":
      case "idem_low":
        return { tag: `${turnKey}:${index}` };
      case "flaky_tool": {
        const mode = turnPrng.weighted([
          { weight: 6, value: "normal" },
          { weight: 2, value: "throw" },
          { weight: 2, value: "slow" },
        ] as const);
        return {
          tag: `${turnKey}:${index}`,
          ...(mode === "throw" ? { shouldThrow: true } : {}),
          ...(mode === "slow" ? { slow: true } : {}),
        };
      }
      case "notify":
        return { body: `DST notification ${turnKey}:${index} for ${sessionId}` };
      case "wake_me_at":
        return { inMs: turnPrng.int(100, 60_000), note: `wake ${turnKey}:${index}` };
      case "cancel_wake": {
        const known = this.sessionTimers.get(sessionId);
        const timerId = known && known.length > 0 ? turnPrng.pick(known) : `wake:${sessionId}:missing`;
        return { timerId };
      }
      case "follow":
        return { thread: `follow:${sessionId}:${turnPrng.int(0, 2)}` };
      case "ask_user":
        return { question: `Proceed with ${turnKey}:${index}?` };
      case "memory_read":
        return {
          path: turnPrng.pick([
            "instructions.md",
            "index.md",
            "notes/prefs.md",
            `progress/${sessionId}.md`,
          ]),
        };
      case "memory_write": {
        const valid = ["notes/prefs.md", `progress/${sessionId}.md`, "index.md"] as const;
        const path = turnPrng.bool(0.25)
          ? turnPrng.pick(ADVERSARIAL_MEMORY_PATHS)
          : turnPrng.pick(valid);
        return { path, content: `memory ${turnKey}:${index}\n` };
      }
      case "memory_list":
        return turnPrng.bool(0.5) ? {} : { dir: "notes" };
      case "memory_delete": {
        const valid = ["notes/prefs.md", `progress/${sessionId}.md`] as const;
        const path = turnPrng.bool(0.35)
          ? turnPrng.pick(ADVERSARIAL_MEMORY_PATHS)
          : turnPrng.pick(valid);
        return { path };
      }
      default:
        return { tag: `${turnKey}:${index}` };
    }
  }

  private async executePlan(
    plan: TurnPlan,
    input: RunInput & { ask?: Ask },
    quiescing: boolean,
  ): Promise<void> {
    const toolMap = new Map<string, Tool>(input.tools.map((t) => [t.name, t]));

    for (let idx = 0; idx < plan.calls.length; idx++) {
      const call = plan.calls[idx]!;
      if (quiescing && !plan.initiated.has(call.callId)) {
        continue;
      }

      if (call.kind === "harness") {
        if (quiescing) {
          continue;
        }
        // Tier-2 Convention #4: fresh harness ask calls use per-run call IDs so retries after
        // interrupted or closed deferrals never reuse spent approval/expiry/journal keys.
        const callId = `${input.runId}:h${idx}`;
        if (this.answeredCallIds.has(callId)) {
          continue;
        }
        if (!input.ask) throw new Error("harness runtime requires input.ask");
        plan.initiated.add(call.callId);
        const verdict = await input.ask({
          callId,
          tool: call.tool,
          args: call.args,
          ...(call.reason ? { reason: call.reason } : {}),
        });
        if (verdict === "allow") {
          input.emit?.({ kind: "tool_start", callId, tool: call.tool, args: call.args });
          this.effects.harnessExecutions.push({
            sessionId: input.session.id,
            callId,
            tool: call.tool,
            args: call.args,
          });
          input.emit?.({
            kind: "tool_end",
            callId,
            result: { status: "ok", output: { ok: true, tool: call.tool } },
          });
          continue;
        }
        if (!quiescing && plan.extraAfterDefer && plan.extraAfterDefer.kind === "harness") {
          const extra = plan.extraAfterDefer;
          const extraCallId = `${input.runId}:h_extra`;
          if (!this.answeredCallIds.has(extraCallId)) {
            const extraVerdict = await input.ask({
              callId: extraCallId,
              tool: extra.tool,
              args: extra.args,
              ...(extra.reason ? { reason: extra.reason } : {}),
            });
            if (extraVerdict === "allow") {
              this.effects.harnessExecutions.push({
                sessionId: input.session.id,
                callId: extraCallId,
                tool: extra.tool,
                args: extra.args,
              });
            }
          }
        }
        break;
      }

      const tool = toolMap.get(call.tool);
      if (!tool) continue;
      plan.initiated.add(call.callId);
      const result = await tool.invoke(call.callId, call.args);

      if (call.tool === "wake_me_at" && result.status === "ok") {
        const timerId = (result.output as { timerId?: unknown } | null)?.timerId;
        if (typeof timerId === "string") {
          const existing = this.sessionTimers.get(input.session.id) ?? [];
          if (!existing.includes(timerId)) {
            existing.push(timerId);
            this.sessionTimers.set(input.session.id, existing);
          }
        }
      } else if (call.tool === "cancel_wake" && result.status === "ok") {
        const cancelled = (result.output as { cancelled?: unknown } | null)?.cancelled;
        const timerId = (call.args as { timerId?: unknown } | null)?.timerId;
        if (cancelled === true && typeof timerId === "string") {
          const existing = this.sessionTimers.get(input.session.id);
          if (existing) {
            this.sessionTimers.set(
              input.session.id,
              existing.filter((id) => id !== timerId),
            );
          }
        }
      }

      if (result.status === "deferred") {
        if (!quiescing && plan.extraAfterDefer && plan.extraAfterDefer.kind === "kernel") {
          const extra = plan.extraAfterDefer;
          const extraTool = toolMap.get(extra.tool);
          if (extraTool) {
            await extraTool.invoke(extra.callId, extra.args);
          }
        }
        break;
      }
    }
  }

  private notify(): void {
    for (const w of this.waiters) {
      if (this.runs.length >= w.count) w.resolve();
    }
    this.waiters = this.waiters.filter((w) => this.runs.length < w.count);
  }
}
