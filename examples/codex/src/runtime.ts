import type { HarnessRuntime, CallId, PermissionAsk, RunInput, RunResult, Tool, ToolResult } from "@aoa-dev/sdk";
import { type Answer, encode, renderAnswer, renderUserMessage, resultText } from "@aoa-dev/sdk/prompt";
import { Connection, RpcError, type SpawnCodex, spawnAppServer } from "./connection.ts";
import type {
  ApprovalDecision,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangePatchUpdatedNotification,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  InitializeParams,
  ItemNotification,
  McpServerElicitationRequestResponse,
  PermissionProfile,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ThreadResponse,
  ThreadResumeParams,
  ThreadStartParams,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnCompletedNotification,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol.ts";

export type CodexRuntimeConfig = {
  /** aoa's system prompt; Codex adds it to its own instructions. */
  developerInstructions: string;
  /** Passed to Codex when set; otherwise Codex's own default model. */
  model?: string;
  /** Working directory for sessions that have no workdir of their own. */
  cwd: string;
  /**
   * Runs every thread in Codex's auto review mode (workspace-write sandbox, approvals on request, answered by Codex's
   * auto-review subagent instead of the user), for an agent whose work should not stop on the user (a reviewer).
   * It overrides the user's sandbox and approval policy so the mode holds even when their Codex runs with full access.
   */
  autoReview?: boolean;
  /** Starts the app server; tests hand in a scripted one. */
  spawn?: SpawnCodex;
};

/** The kernel's names for what Codex asks permission for; a grant matches on the name and the args. */
const HARNESS_TOOLS = {
  command: "codex_command",
  fileChange: "codex_file_change",
  permissions: "codex_permissions",
} as const;

const HARNESS_TOOL_NAMES = new Set<string>(Object.values(HARNESS_TOOLS));

const WAITS_FOR_USER =
  "This call waits for the user's decision. It has not been executed. The turn stops here; the answer arrives in a later message.";

const USE_ASK_USER =
  "Nobody can answer here. If you need the user's decision, call the ask_user tool; its answer arrives in a later turn.";

/** How long to wait for Codex to confirm an interrupt before the process is killed anyway. */
const INTERRUPT_GRACE_MS = 10_000;

/**
 * A runtime that runs each aoa run as one turn of a Codex thread, in a `codex app-server` started for the run.
 * Codex runs its own tools under the user's Codex configuration and asks the kernel's gate when that configuration
 * says to ask; aoa's tools reach Codex as dynamic tools and go through `Tool.invoke` like any other runtime's.
 */
export function codexRuntime(config: CodexRuntimeConfig): HarnessRuntime {
  const spawn = config.spawn ?? spawnAppServer;
  return {
    kind: "harness",
    async run(input) {
      const { ask, signal } = input;
      signal.throwIfAborted();
      const cwd = input.session.workdir ?? config.cwd;
      const proc = await spawn(cwd);
      const run = new CodexRun(config, input, ask, cwd);
      const onAbort = () => run.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await run.go(new Connection(proc, run));
      } finally {
        signal.removeEventListener("abort", onAbort);
        run.done();
        proc.kill();
      }
    },
  };
}

type Stop = { deferred: CallId } | { failure: unknown };

class CodexRun {
  private conn!: Connection;
  private threadId: string | null = null;
  /** File changes by item, from the item notifications: an approval request for one carries no diff. */
  private readonly changes = new Map<string, FileUpdateChange[]>();
  /** How often each call id base appeared in this run, so one item asking twice gets two ids. */
  private readonly seen = new Map<string, number>();
  /** Set once the run must end: its first deferred call, or a failed `ask` or `invoke`. */
  private stop: Stop | null = null;
  private interruptTurn: string | null = null;
  /** The turn this run started, once Codex has said its id. */
  private turnId: string | null = null;
  /** Server requests being answered; an interrupt waits until their replies are out. */
  private answering = 0;
  private interrupting = false;
  private finished = false;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private ended!: (turn: Turn | null) => void;
  private readonly turnEnd = new Promise<Turn | null>((resolve) => (this.ended = resolve));

  constructor(
    private readonly config: CodexRuntimeConfig,
    private readonly input: RunInput,
    private readonly ask: (a: PermissionAsk) => Promise<"allow" | "defer">,
    private readonly cwd: string,
  ) {}

  async go(conn: Connection): Promise<RunResult> {
    this.conn = conn;
    const init: InitializeParams = {
      clientInfo: { name: "aoa", title: null, version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await conn.request("initialize", init);
    conn.notify("initialized");

    const { ref } = this.input.session;
    const model = this.config.model === undefined ? {} : { model: this.config.model };
    const reviewer = this.config.autoReview
      ? ({ sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } as const)
      : {};
    const common = { cwd: this.cwd, developerInstructions: this.config.developerInstructions, ...model, ...reviewer };
    const { thread } =
      ref === null
        ? await conn.request<ThreadResponse>("thread/start", {
            ...common,
            dynamicTools: this.input.tools.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.schema })),
          } satisfies ThreadStartParams)
        : await conn.request<ThreadResponse>("thread/resume", { threadId: ref, ...common } satisfies ThreadResumeParams);
    this.threadId = thread.id;

    // `attempts` counts failed runs, so a non-zero one means an earlier attempt at these events stopped part way.
    const retry = this.input.events.some((e) => e.attempts > 0);
    const text = renderUserMessage(this.input, retry, renderCodexAnswer);
    // Stopped while the thread was being set up: no turn starts.
    if (this.stop && "failure" in this.stop) throw this.stop.failure;
    const started = await conn.request<TurnStartResponse>("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text, text_elements: [] }],
    } satisfies TurnStartParams);
    this.turnId = started.turn.id;
    // A stop that came while the turn was being started interrupts it now.
    if (this.stop) this.halt(this.turnId, this.stop);
    this.interruptIfQuiet();
    const turn = await Promise.race([this.turnEnd, conn.closed]);

    const sessionRef = thread.id;
    if (this.stop && "failure" in this.stop) throw this.stop.failure;
    if (this.stop) return { end: { kind: "deferred", callId: this.stop.deferred }, sessionRef };
    if (turn?.status === "failed") throw new Error(`the Codex turn failed: ${turn.error?.message ?? "unknown error"}`);
    if (turn?.status !== "completed") throw new Error(`the Codex turn ended ${turn?.status ?? "without completing"}`);
    return { end: { kind: "silent" }, sessionRef };
  }

  done(): void {
    this.finished = true;
    if (this.grace !== null) clearTimeout(this.grace);
  }

  notification(method: string, params: unknown): void {
    const p = params as { threadId?: string };
    if (p.threadId !== this.threadId) return;
    switch (method) {
      case "turn/completed":
        return this.ended((params as TurnCompletedNotification).turn);
      case "item/started":
      case "item/completed": {
        const { item } = params as ItemNotification;
        if (item.type === "fileChange" && item.changes) this.changes.set(item.id, item.changes);
        return;
      }
      case "item/fileChange/patchUpdated": {
        const n = params as FileChangePatchUpdatedNotification;
        this.changes.set(n.itemId, n.changes);
        return;
      }
    }
  }

  /** The host is stopping: the turn is interrupted and the run rejects with `reason` once Codex has saved the thread. */
  abort(reason: unknown): void {
    if (this.turnId === null) {
      // Before the turn starts there is nothing to interrupt; `go` sees the stop once it has the turn's id.
      this.stop ??= { failure: reason };
      return;
    }
    this.halt(this.turnId, { failure: reason });
    this.interruptIfQuiet();
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.answering++;
    return this.answer(method, params);
  }

  private async answer(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const p = params as CommandExecutionRequestApprovalParams;
        const args = {
          command: p.command ?? null,
          cwd: p.cwd ?? null,
          ...(p.kind === "writeStdin" ? { kind: p.kind } : {}),
          ...(p.additionalPermissions ? { additionalPermissions: p.additionalPermissions } : {}),
          ...(p.networkApprovalContext ? { networkApprovalContext: p.networkApprovalContext } : {}),
          // Nothing names the action, so it must not match a grant for some other unnamed one.
          ...(!p.command && !p.networkApprovalContext ? { item: p.itemId } : {}),
        };
        const key = p.approvalId ? `${p.itemId}:${p.approvalId}` : p.itemId;
        return { decision: decision(await this.gate(p.turnId, key, HARNESS_TOOLS.command, args, p.reason)) };
      }
      case "item/fileChange/requestApproval": {
        const p = params as FileChangeRequestApprovalParams;
        const changes = this.changes.get(p.itemId);
        // Without its changes the request names no action, so it must not match a grant for another one.
        const args = { ...(changes ? { changes } : { item: p.itemId }), ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}) };
        return { decision: decision(await this.gate(p.turnId, p.itemId, HARNESS_TOOLS.fileChange, args, p.reason)) };
      }
      case "item/permissions/requestApproval": {
        const p = params as PermissionsRequestApprovalParams;
        const allowed = await this.gate(p.turnId, p.itemId, HARNESS_TOOLS.permissions, { permissions: p.permissions, cwd: p.cwd }, p.reason);
        const granted: PermissionProfile = {};
        if (allowed && p.permissions.network !== null) granted.network = p.permissions.network;
        if (allowed && p.permissions.fileSystem !== null) granted.fileSystem = p.permissions.fileSystem;
        return { permissions: granted, scope: "turn" } satisfies PermissionsRequestApprovalResponse;
      }
      case "item/tool/call":
        return this.toolCall(params as DynamicToolCallParams);
      case "item/tool/requestUserInput": {
        const p = params as ToolRequestUserInputParams;
        return { answers: Object.fromEntries(p.questions.map((q) => [q.id, { answers: [USE_ASK_USER] }])) } satisfies ToolRequestUserInputResponse;
      }
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
      default:
        throw new RpcError(-32601, `aoa does not handle ${method}`);
    }
  }

  /** Asks the kernel's gate; anything but `allow` ends the run. Once the run is ending, nothing more is asked. */
  private async gate(turnId: string, key: string, tool: string, args: unknown, reason?: string | null): Promise<boolean> {
    if (this.stop) return false;
    const callId = this.callId(turnId, key);
    let verdict: "allow" | "defer";
    try {
      verdict = await this.ask({ callId, tool, args, ...(reason ? { reason } : {}) });
    } catch (err) {
      this.halt(turnId, { failure: err });
      return false;
    }
    if (verdict === "allow") return true;
    this.halt(turnId, { deferred: callId });
    return false;
  }

  private async toolCall(p: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const reply = (text: string, success: boolean): DynamicToolCallResponse => ({ contentItems: [{ type: "inputText", text }], success });
    if (this.stop) return reply(WAITS_FOR_USER, false);
    const tool: Tool | undefined = p.namespace === null ? this.input.tools.find((t) => t.name === p.tool) : undefined;
    if (!tool) return reply(`There is no tool named ${p.tool}.`, false);
    const callId = this.callId(p.turnId, p.callId);
    let result: ToolResult;
    try {
      result = await tool.invoke(callId, p.arguments);
    } catch (err) {
      this.halt(p.turnId, { failure: err });
      return reply("The call failed.", false);
    }
    switch (result.status) {
      case "ok":
        return reply(resultText(result.output), true);
      case "error":
        return reply(result.error, false);
      case "unknown":
        return reply(result.message, true);
      case "deferred":
        this.halt(p.turnId, { deferred: callId });
        return reply(WAITS_FOR_USER, true);
    }
  }

  /**
   * Codex's ids are unique per item, and a turn id is new for every run, so the session, turn and item make an id
   * the kernel has not answered before. An item that asks again within the turn gets its occurrence number.
   */
  private callId(turnId: string, key: string): CallId {
    const base = `${this.input.session.id}:${turnId}:${key}`;
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  }

  /**
   * Ends the run: the turn is interrupted once the reply to the request at hand is out, and the run waits for Codex
   * to confirm, so the thread is saved in a state it can resume from.
   */
  private halt(turnId: string, stop: Stop): void {
    this.stop ??= stop;
    this.interruptTurn ??= turnId;
  }

  replied(): void {
    this.answering--;
    this.interruptIfQuiet();
  }

  private interruptIfQuiet(): void {
    if (this.answering > 0) return;
    if (this.interruptTurn === null || this.interrupting || this.finished) return;
    this.interrupting = true;
    this.conn.request("turn/interrupt", { threadId: this.threadId!, turnId: this.interruptTurn } satisfies TurnInterruptParams).catch(() => {});
    this.grace = setTimeout(() => this.ended(null), INTERRUPT_GRACE_MS);
  }
}

const decision = (allowed: boolean): ApprovalDecision => (allowed ? "accept" : "decline");

const ACTION: Record<string, string> = {
  [HARNESS_TOOLS.command]: "running the command",
  [HARNESS_TOOLS.fileChange]: "the file changes",
  [HARNESS_TOOLS.permissions]: "the extra permissions",
};

/**
 * Codex's own calls are not executed when the user approves them: the kernel grants the exact call, and Codex has
 * to make it again for the grant to apply. Answers to aoa's tools read as they do for any runtime.
 */
function renderCodexAnswer(a: Answer): string {
  if (!HARNESS_TOOL_NAMES.has(a.tool)) return renderAnswer(a);
  const head = `<answer call=${encode(a.callId)} tool=${encode(a.tool)} verdict=${encode(a.verdict)}>`;
  const action = `${ACTION[a.tool]} you asked permission for earlier, ${encode(a.args)}`;
  const body =
    a.verdict === "approve"
      ? [
          `The user approved ${action}. It has not been done yet: it was declined while the user was asked.`,
          "Do it again now, exactly as before (the same command in the same working directory, or the same file changes); this time it is allowed without asking.",
        ]
      : [
          `The user denied ${action}. It was not done; do not try it again unless the user asks for it.`,
          `The user said: ${encode(a.text ?? "")}`,
        ];
  return [head, ...body, "</answer>"].join("\n");
}
