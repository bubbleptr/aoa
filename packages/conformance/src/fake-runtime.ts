import type { AgentRuntime, CallId, RunEnd, RunInput, RunResult, ToolResult } from "@aoa/kernel";

export type ScriptedCall = { tool: string; callId: CallId; args?: unknown };

/** What one run does. Fixed call ids make a rerun replay the same ids, as a resumed transcript would. */
export type RunScript = {
  /** The run waits on this before doing anything, so a test can hold it open. */
  gate?: Promise<void>;
  calls?: ScriptedCall[];
  /** Thrown after the calls: an ordinary runtime failure. */
  fail?: Error;
  end?: RunEnd;
  sessionRef?: string;
};

export type ObservedRun = { input: RunInput; toolResults: ToolResult[] };

/** Plays one script per run, in order; runs past the end of the script list end silently. */
export class ScriptedRuntime implements AgentRuntime {
  readonly runs: ObservedRun[] = [];
  active = 0;
  maxActive = 0;
  private waiters: { count: number; resolve: () => void }[] = [];

  constructor(private readonly scripts: RunScript[] = []) {}

  async run(input: RunInput): Promise<RunResult> {
    const script = this.scripts[this.runs.length] ?? {};
    const observed: ObservedRun = { input, toolResults: [] };
    this.runs.push(observed);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.notify();
    try {
      await script.gate;
      for (const call of script.calls ?? []) {
        const tool = input.tools.find((t) => t.name === call.tool);
        if (!tool) throw new Error(`script calls unknown tool ${call.tool}`);
        observed.toolResults.push(await tool.invoke(call.callId, call.args ?? {}));
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
