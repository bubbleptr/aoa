import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessRuntime, CallId, PermissionAsk, RunInput, RunResult } from "@aoa/kernel";
import { type Answer, encode, renderAnswer, renderUserMessage } from "@aoa/runtime-pi/prompt";
import { CallTable, type Bridge, startBridge } from "./bridge.ts";
import { Connection, RpcError, spawnDsh } from "./connection.ts";
import type { DshProcess, DshSpawn } from "./connection.ts";
import { DSH_PROFILE, DSH_VERSION, type PermissionPreset, patchYaml } from "./patch.ts";
import type {
  ApprovalRequestParams,
  ApprovalRequestResult,
  InitializeParams,
  InitializeResult,
  PtcDispatchStartData,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionQueryParams,
  SessionQueryResult,
  SessionResumeParams,
  SessionStatusNotification,
  ToolCallData,
  UserQuestionResult,
} from "./protocol.ts";

/** dsh's default model route; aoa does not offer another. */
export const DSH_PROVIDER = "deepseek-official";

/** How long dsh has to answer `shutdown` and exit before it is signaled. */
export const SHUTDOWN_GRACE_MS = 10_000;

/** How long each signal gets before the next one, and before the run gives up waiting for the process. */
export const KILL_WAIT_MS = 1_000;

export type DshRuntimeConfig = {
  /** aoa's system prompt; dsh adds it after its own instructions (the patch's `personaSuffix`). */
  systemPrompt: string;
  /** A dsh model name, e.g. `deepseek-flash`. */
  model: string;
  /** The key read from `apiKeyEnv`, or undefined when it is not set; the child gets it as `DEEPSEEK_API_KEY`. */
  apiKey: string | undefined;
  /** The variable the key came from, for the error when it is missing. */
  apiKeyEnv: string;
  /** `$DSH_HOME` for aoa's runs: a directory of aoa's own, never the user's dsh home. */
  home: string;
  /** Working directory for sessions that have no workdir of their own. */
  cwd: string;
  /** The executable; default `dsh`. */
  command?: string;
  /** dsh's permission preset, written into the patch; default `workspace-write` (its sandbox, approvals on ask). */
  preset?: PermissionPreset;
  /** How long `shutdown` may take before the process is killed; default {@link SHUTDOWN_GRACE_MS}. */
  shutdownMs?: number;
  /** The environment the child's is derived from; default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where dsh's refusals and failures are reported; default `console.error`. */
  log?: (line: string) => void;
  /** Starts dsh; tests hand in a scripted one. */
  spawn?: DshSpawn;
};

/** The key variable dsh reads by itself. */
export const DSH_KEY_ENV = "DEEPSEEK_API_KEY";

/** The variable the patch reads aoa's system prompt from. */
export const DSH_PROMPT_ENV = "AOA_DSH_SYSTEM_PROMPT";

/**
 * The child's environment: the key, the home, aoa's prompt, and only the few things any program needs.
 * The parent's other variables (other agents' keys among them) do not come along.
 */
export function childEnv(o: {
  home: string;
  apiKey: string;
  systemPrompt: string;
  parent: Record<string, string | undefined>;
}): Record<string, string> {
  const env: Record<string, string> = { DSH_HOME: o.home, [DSH_KEY_ENV]: o.apiKey, [DSH_PROMPT_ENV]: o.systemPrompt };
  for (const name of ["PATH", "HOME", "TMPDIR"]) {
    const value = o.parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * A runtime that runs each aoa run as one dsh session, in a `dsh --profile sdk` process started for the run.
 * dsh runs its own tools under its own approval and sandbox settings and asks the kernel's gate when it
 * wants approval; aoa's tools reach dsh over an MCP bridge and go through `Tool.invoke` like any other
 * runtime's. dsh has no way to interrupt a turn, so a run that must stop replies to the request at hand,
 * shuts dsh down, and kills it if it does not go.
 */
export function dshRuntime(config: DshRuntimeConfig): HarnessRuntime {
  return {
    kind: "harness",
    async run(input) {
      const { ask } = input;
      const command = config.command ?? "dsh";
      const launcher = config.spawn ?? spawnDsh;
      const version = (await launcher.version(command)).trim();
      if (version !== DSH_VERSION) {
        throw new Error(
          `this aoa runs dsh ${DSH_VERSION}, but ${command} --version reports ${version === "" ? "nothing" : version}: install that dsh or point dsh.command at it`,
        );
      }
      if (config.apiKey === undefined || config.apiKey === "") {
        throw new Error(`${config.apiKeyEnv} is not set: the dsh agent ${config.model} needs it`);
      }
      const cwd = input.session.workdir ?? config.cwd;
      return new DshRun(config, input, ask, cwd, launcher, command, config.preset ?? "workspace-write").go();
    },
  };
}

type Stop = { deferred: CallId } | { failure: unknown };

class DshRun {
  /** The dsh session: the one aoa resumes, or the one aoa made up for a new session. */
  private readonly sessionId: string;
  private conn!: Connection;
  private proc: DshProcess | null = null;
  private bridge: Bridge | null = null;
  private patch: string | null = null;
  private readonly table = new CallTable();
  /** Set once the run must end: its first deferred call, or a failed `ask`. */
  private stop: Stop | null = null;
  /** How the session's last turn ended, from the `turn/end` event: a model failure must fail the run. */
  private turnEnd: { kind: string; error?: unknown } | null = null;
  /** Set when the run must fail even though dsh went idle, e.g. the turn ended with an error. */
  private endError: Error | null = null;
  /** What `shutdown` answered with an error, if it did; the run is over by then, so it is only reported. */
  private shutdownError: Error | null = null;
  /** Whether the child has exited, so the run does not signal a process that is already gone or going. */
  private exited = false;
  /** Whether `session/prompt` was sent: an idle before that says nothing about this run's work. */
  private prompting = false;
  private prompted = false;
  /** An idle that arrived while the prompt was still being acknowledged. */
  private idleSeen = false;
  /** Server requests whose reply has not been written yet; dsh is stopped only after the last of them. */
  private replying = 0;
  private settling: Promise<void> | null = null;
  private finished = false;
  private ended!: () => void;
  private readonly end = new Promise<void>((resolve) => (this.ended = resolve));
  private readonly log: (line: string) => void;

  constructor(
    private readonly config: DshRuntimeConfig,
    private readonly input: RunInput,
    private readonly ask: (a: PermissionAsk) => Promise<"allow" | "defer">,
    private readonly cwd: string,
    private readonly launcher: DshSpawn,
    private readonly command: string,
    private readonly preset: PermissionPreset,
  ) {
    this.sessionId = input.session.ref ?? crypto.randomUUID();
    const log = config.log ?? ((line: string) => console.error(`${new Date().toISOString()} dsh: ${line}`));
    this.log = (line) => log(`dsh: ${line}`);
  }

  async go(): Promise<RunResult> {
    const { config, cwd } = this;
    let proc: DshProcess | null = null;
    try {
      this.bridge = await startBridge({
        sessionId: this.input.session.id,
        dshSessionId: this.sessionId,
        tools: this.input.tools,
        table: this.table,
        replied: () => this.bridgeReplied(),
        deferred: (callId) => this.halt({ deferred: callId }),
        stopping: () => this.stop !== null,
        log: this.log,
      });
      const patchDir = join(config.home, "patches");
      mkdirSync(patchDir, { recursive: true });
      this.patch = join(patchDir, `${this.input.runId.replace(/[^A-Za-z0-9_-]/g, "_")}.cordis.patch.yml`);
      writeFileSync(this.patch, patchYaml({ url: this.bridge.url, preset: this.preset }));

      proc = await this.launcher.spawn({
        command: this.command,
        args: ["--profile", DSH_PROFILE, "--patch", this.patch],
        cwd,
        env: childEnv({
          home: config.home,
          apiKey: config.apiKey!,
          systemPrompt: config.systemPrompt,
          parent: config.env ?? process.env,
        }),
      });
      this.proc = proc;
      this.conn = new Connection(proc, {
        request: (method, params) => this.request(method, params),
        notification: (method, params) => this.notification(method, params),
        replied: () => this.replied(),
      });

      const init: InitializeParams = {
        cwd,
        approvalRequests: true,
        provider: DSH_PROVIDER,
        model: config.model,
        capabilities: { userQuestions: true },
      };
      await this.conn.request<InitializeResult>("initialize", init);
      if (this.input.session.ref !== null) {
        await this.conn.request("session/resume", { sessionId: this.sessionId } satisfies SessionResumeParams);
        // A resumed session keeps the sandbox and approval policy it was saved with, and those win over the
        // patch's defaults. dsh's own /permission command is the one way to change them for this session.
        await this.applyPreset();
      }
      // `attempts` counts failed runs, so a non-zero one means an earlier attempt at these events stopped part way.
      const retry = this.input.events.some((e) => e.attempts > 0);
      const text = renderUserMessage(this.input, retry, renderDshAnswer);
      this.prompting = true;
      await this.conn.request<SessionPromptResult>("session/prompt", {
        sessionId: this.sessionId,
        contentBlocks: [{ type: "text", text }],
      } satisfies SessionPromptParams);
      this.prompted = true;
      if (this.idleSeen) this.settle();
      // A process that goes away while the run is already stopping (idle, or a deferred call) is the stop
      // working, not a failure; anything else is an error the kernel should retry.
      const closed = this.conn.closed.catch((err: unknown) => {
        if (this.settling === null) throw err;
        return this.end;
      });
      await Promise.race([this.end, closed]);

      const sessionRef = this.sessionId;
      if (this.stop && "failure" in this.stop) throw this.stop.failure;
      if (this.stop) return { end: { kind: "deferred", callId: this.stop.deferred }, sessionRef };
      if (this.endError !== null) throw this.endError;
      return { end: { kind: "silent" }, sessionRef };
    } finally {
      this.finished = true;
      this.bridge?.close();
      if (this.patch !== null) rmSync(this.patch, { force: true });
      // A process that exited on its own (after `shutdown`, or by crashing) is left alone.
      if (!this.exited) proc?.kill("SIGKILL");
    }
  }

  /**
   * Sets the configured permission preset on a resumed session, through dsh's `/permission` command. dsh
   * pins sandbox mode and approval policy per session and a resumed session keeps the values it was saved
   * with, so without this a task started under a wider preset would stay wide after the config tightens.
   */
  private async applyPreset(): Promise<void> {
    const result = await this.conn.request<SessionQueryResult>("session/query", {
      sessionId: this.sessionId,
      contentBlocks: [{ type: "text", text: `/permission ${this.preset}` }],
    } satisfies SessionQueryParams);
    if (result?.kind !== "command") {
      throw new Error(
        `dsh has no /permission command in this profile, so aoa cannot set its permission preset ${this.preset} on the resumed session`,
      );
    }
    const outcome = result.execution.result;
    if (outcome.kind !== "success") throw new Error(`dsh refused the permission preset ${this.preset}: ${outcome.text}`);
  }

  private notification(method: string, params: unknown): void {
    switch (method) {
      case "session.event":
        return this.event((params as SessionEventNotification).event);
      case "session.status": {
        const n = params as SessionStatusNotification;
        if (!this.prompting || n.sessionId !== this.sessionId || n.status !== "idle") return;
        this.idleSeen = true;
        if (this.prompted) this.settle();
        return;
      }
    }
  }

  /** Written synchronously, in the order dsh logged it, so an approval request that follows finds its call. */
  private event(event: SessionEventNotification["event"]): void {
    if (event?.type === "turn/end") {
      const reason = (event.data as { reason?: { kind?: unknown; error?: unknown } } | undefined)?.reason;
      if (typeof reason?.kind === "string") this.turnEnd = { kind: reason.kind, ...(reason.error === undefined ? {} : { error: reason.error }) };
    } else if (event?.type === "tool/call") {
      const d = event.data as ToolCallData | undefined;
      if (typeof d?.callId === "string" && typeof d.name === "string") this.table.add(this.sessionId, d.callId, d.name, d.arguments);
    } else if (event?.type === "tool/ptc-dispatch-start") {
      const d = event.data as PtcDispatchStartData | undefined;
      if (typeof d?.subCallId === "string" && typeof d.name === "string") this.table.add(this.sessionId, d.subCallId, d.name, d.arguments);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    this.replying++;
    switch (method) {
      case "approval/request":
        return this.approval(params as ApprovalRequestParams);
      case "user-question/ask":
        // dsh's own question tool is disabled by the patch; if it asks anyway, nobody here can answer.
        return { cancelled: true } satisfies UserQuestionResult;
      default:
        throw new RpcError(-32601, `aoa does not handle ${method}`);
    }
  }

  private async approval(p: ApprovalRequestParams): Promise<ApprovalRequestResult> {
    const call = p.callId === undefined ? null : this.table.get(p.sessionId, p.callId);
    if (call === null) {
      this.log(`refused an approval request for ${p.toolName} in session ${p.sessionId}: aoa has no tool call for it`);
      return { outcome: "rejected" };
    }
    if (this.stop !== null) return { outcome: "rejected" };
    const callId = `${this.input.session.id}:${p.callId}`;
    let verdict: "allow" | "defer";
    try {
      verdict = await this.ask({ callId, tool: `dsh:${call.tool}`, args: call.args, ...(p.reason ? { reason: p.reason } : {}) });
    } catch (err) {
      this.halt({ failure: err });
      return { outcome: "rejected" };
    }
    if (verdict === "allow") return { outcome: "allowed-once" };
    this.halt({ deferred: callId });
    return { outcome: "rejected" };
  }

  /** Ends the run: the reply to the request at hand goes out first, then dsh is shut down. */
  private halt(stop: Stop): void {
    this.stop ??= stop;
  }

  /** After a reply to one of dsh's own requests was written. */
  replied(): void {
    if (this.replying > 0) this.replying--;
    this.stopped();
  }

  /** After the answer to one of aoa's MCP calls was written. */
  bridgeReplied(): void {
    this.stopped();
  }

  /** dsh is shut down only once nothing of this run is still waiting on an answer from aoa. */
  private stopped(): void {
    if (this.stop !== null && this.replying === 0 && this.bridge?.idle() !== false) this.settle();
  }

  private settle(): void {
    if (this.finished) return;
    this.settling ??= (async () => {
      // A turn that ended with an error is a failed run even though the agent goes idle and the process
      // stays up: the kernel has to hear about it, or an auth or model failure would look like a quiet run.
      if (this.stop === null) this.endError = await this.failure();
      await this.shutdown();
      this.ended();
    })();
  }

  /** Why the session's turn failed, or null: the logged `turn/end`, or a live failure `session/wait` reports. */
  private async failure(): Promise<Error | null> {
    if (this.turnEnd?.kind === "error") {
      const error = this.turnEnd.error as { message?: unknown; code?: unknown } | undefined;
      const message = typeof error?.message === "string" ? error.message : JSON.stringify(error ?? null);
      return new Error(`dsh ended the turn with an error: ${message}`);
    }
    if (this.turnEnd?.kind === "completed" || this.turnEnd?.kind === "max-tokens") return null;
    // No durable verdict (a crash before `turn/end` left it open): ask the server whether the live agent failed.
    try {
      await this.conn.request("session/wait", { sessionId: this.sessionId });
      return null;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * dsh has no interrupt: `shutdown` is the one way to stop it, and it answers before it flushes the session
   * and exits. So the process itself has to go before the run is over; if it does not, it is signaled.
   */
  private async shutdown(): Promise<void> {
    const answered = this.conn.request("shutdown").then(
      () => {},
      (err: unknown) => (this.shutdownError = err instanceof Error ? err : new Error(String(err))),
    );
    const grace = this.config.shutdownMs ?? SHUTDOWN_GRACE_MS;
    if (await this.exitedWithin(grace)) {
      await answered;
      this.reportShutdown();
      return;
    }
    this.proc?.kill("SIGTERM");
    if (await this.exitedWithin(grace)) {
      await answered;
      this.reportShutdown();
      this.log("dsh did not exit after shutdown on its own; it exited after SIGTERM");
      return;
    }
    this.proc?.kill("SIGKILL");
    if (await this.exitedWithin(KILL_WAIT_MS)) {
      await answered;
      this.reportShutdown();
      return;
    }
    // Still there after SIGKILL: nothing more to wait for. The pending shutdown request settles when the
    // process finally goes away, or with the run's connection.
    this.log("dsh did not exit after SIGKILL; giving up on it");
    void answered;
  }

  /** A shutdown that answered with an error is reported; the run is over by then, so it is not thrown. */
  private reportShutdown(): void {
    if (this.shutdownError !== null) this.log(`shutdown failed: ${this.shutdownError.message}`);
  }

  /** Waits for the process to exit, up to `ms`. */
  private exitedWithin(ms: number): Promise<boolean> {
    const proc = this.proc;
    if (proc === null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      proc.exited.then(
        () => (clearTimeout(timer), (this.exited = true), resolve(true)),
        () => (clearTimeout(timer), (this.exited = true), resolve(true)),
      );
    });
  }
}

/**
 * dsh's own calls are not executed when the user approves them: the kernel grants the exact call, and dsh has
 * to make it again for the grant to apply. Answers to aoa's own tools read as they do for any runtime.
 */
function renderDshAnswer(a: Answer): string {
  if (!a.tool.startsWith("dsh:")) return renderAnswer(a);
  const head = `<answer call=${encode(a.callId)} tool=${encode(a.tool)} verdict=${encode(a.verdict)}>`;
  const action = `running ${encode(a.tool.replace(/^dsh:/, ""))} with the arguments ${encode(a.args)}`;
  const body =
    a.verdict === "approve"
      ? [
          `The user approved ${action}. It has not been done yet: it was rejected while the user was asked.`,
          "Do it again now, exactly as before; this time it is allowed without asking.",
        ]
      : [`The user denied ${action}. It was not done; do not try it again unless the user asks for it.`, `The user said: ${encode(a.text ?? "")}`];
  return [head, ...body, "</answer>"].join("\n");
}
