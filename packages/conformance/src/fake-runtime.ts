import type { Ask, CallId, RunEnd, RunInput, RunResult, ToolResult } from "@aoa/kernel";

/**
 * `args` may be computed from the run's input, e.g. to name the session's own progress file.
 * With `harness`, the call is the harness's own tool: the runtime asks the kernel's gate and "executes" it on allow.
 */
export type ScriptedCall = {
  tool: string;
  callId: CallId;
  args?: object | ((input: RunInput) => unknown);
  harness?: true;
  reason?: string;
};

/** What one run does. Fixed call ids make a rerun replay the same ids, as a resumed transcript would. */
export type RunScript = {
  /** The run waits on this before doing anything, so a test can hold it open. */
  gate?: Promise<void>;
  /** Emitted as one text delta before the calls, as a model's words would be. */
  text?: string;
  calls?: ScriptedCall[];
  /** After the calls, the run waits for its signal and then fails with the signal's reason: a run only a stop ends. */
  hang?: true;
  /** Thrown after the calls: an ordinary runtime failure. */
  fail?: Error;
  end?: RunEnd;
  sessionRef?: string;
};

export type ObservedRun = { input: RunInput; toolResults: ToolResult[]; asks: ("allow" | "defer")[] };

/**
 * Plays one script per run, in order; runs past the end of the script list end silently. A `harness` one is a
 * tier-2 runtime: it gets `ask` and the kernel holds untrusted input for it.
 */
export class ScriptedRuntime {
  readonly kind: "kernel" | "harness";
  readonly runs: ObservedRun[] = [];
  /** The harness calls that ran because the gate allowed them, in order. */
  readonly harnessEffects: { tool: string; args: unknown }[] = [];
  active = 0;
  maxActive = 0;
  private waiters: { count: number; resolve: () => void }[] = [];

  constructor(
    private readonly scripts: RunScript[] = [],
    o: { kind?: "kernel" | "harness" } = {},
  ) {
    this.kind = o.kind ?? "kernel";
  }

  async run(input: RunInput & { ask?: Ask }): Promise<RunResult> {
    const script = this.scripts[this.runs.length] ?? {};
    const observed: ObservedRun = { input, toolResults: [], asks: [] };
    this.runs.push(observed);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.notify();
    try {
      await script.gate;
      if (script.text !== undefined) input.emit?.({ kind: "text", delta: script.text });
      for (const call of script.calls ?? []) {
        const args = typeof call.args === "function" ? call.args(input) : (call.args ?? {});
        if (call.harness) {
          if (!input.ask) throw new Error("the kernel gave this run no permission gate");
          const verdict = await input.ask({ callId: call.callId, tool: call.tool, args, ...(call.reason ? { reason: call.reason } : {}) });
          observed.asks.push(verdict);
          if (verdict === "allow") this.harnessEffects.push({ tool: call.tool, args });
          continue;
        }
        const tool = input.tools.find((t) => t.name === call.tool);
        if (!tool) throw new Error(`script calls unknown tool ${call.tool}`);
        observed.toolResults.push(await tool.invoke(call.callId, args));
      }
      if (script.hang) {
        const { signal } = input;
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (script.fail) throw script.fail;
      return { end: script.end ?? { kind: "silent" }, sessionRef: script.sessionRef };
    } finally {
      this.active--;
    }
  }

  /** Resolves once `count` runs have started. */
  started(count: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ count, resolve });
      this.notify();
    });
  }

  private notify(): void {
    for (const w of this.waiters.filter((w) => this.runs.length >= w.count)) w.resolve();
    this.waiters = this.waiters.filter((w) => this.runs.length < w.count);
  }
}

export type Gate = { promise: Promise<void>; open(): void };

export function gate(): Gate {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
