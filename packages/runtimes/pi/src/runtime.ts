import type { KernelRuntime, CallId, RunInput, RunResult, Tool, ToolResult } from "@aoa/kernel";
import type { Provider } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createModelRuntime, redact } from "./models.ts";
import { eventMarker, renderUserMessage } from "./prompt.ts";
import { okToPi, text } from "./results.ts";

export type PiRuntimeConfig = {
  /** pi provider id, e.g. `anthropic`. */
  provider: string;
  modelId: string;
  /** Held in memory by pi's model runtime; never written to disk or shown to the model. */
  apiKey?: string;
  agentDir: string;
  /** Where the JSONL transcripts live, one directory per kernel session; a run's `sessionRef` is its file path. */
  sessionsDir: string;
  /** Working directory for sessions that have no workdir of their own. */
  cwd: string;
  /** Fixed for every run so the prompt cache holds; per-run content goes in the user message. */
  systemPrompt: string;
  /** Extra pi-ai providers to register with the model runtime, e.g. a custom endpoint or a scripted test model. */
  providers?: Provider[];
};

const DEFERRED_PLACEHOLDER =
  "This call needs the user's decision. It has not been executed. The run stops here; the answer arrives in a later message.";

export function piRuntime(config: PiRuntimeConfig): KernelRuntime {
  let models: Promise<ModelRuntime> | null = null;
  const modelRuntime = () => (models ??= createModelRuntime(config));
  return {
    kind: "kernel",
    run: async (input) => {
      try {
        return await run(config, await modelRuntime(), input);
      } catch (err) {
        throw redact(err, config.apiKey);
      }
    },
  };
}

async function run(config: PiRuntimeConfig, models: ModelRuntime, input: RunInput): Promise<RunResult> {
  const model = models.getModel(config.provider, config.modelId);
  if (!model) throw new Error(`pi has no model ${config.provider}/${config.modelId}`);

  const cwd = input.session.workdir ?? config.cwd;
  const dir = join(config.sessionsDir, encodeURIComponent(input.session.id));
  // With no ref, an earlier attempt may still have left a transcript: it failed or crashed before the kernel recorded it.
  const ref = input.session.ref ?? latestTranscript(dir);
  const sessionManager = ref === null ? SessionManager.create(cwd, dir) : SessionManager.open(ref, dir, cwd);
  const retry = input.events.some((e) => transcriptHolds(sessionManager, eventMarker(e)));

  const stop = new Stop();
  const ids = new CallIds(input.session.id, sessionManager);
  const { session } = await createAgentSession({
    cwd,
    agentDir: config.agentDir,
    model,
    modelRuntime: models,
    resourceLoader: fixedResources(config.systemPrompt),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    noTools: "builtin",
    customTools: input.tools.map((t) => toPiTool(t, ids, stop)),
  });
  stop.session = session;

  try {
    await session.prompt(renderUserMessage(input, retry), { expandPromptTemplates: false });
    await stop.stopping;
    if (stop.failure) throw stop.failure.error;

    const sessionRef = session.sessionFile;
    if (sessionRef === undefined) throw new Error("pi did not persist the session");
    if (stop.deferred !== null) return { end: { kind: "deferred", callId: stop.deferred }, sessionRef };

    const failure = modelFailure(session);
    if (failure !== null) throw new Error(`the model request failed: ${failure}`);
    return { end: { kind: "silent" }, sessionRef };
  } finally {
    session.dispose();
  }
}

/** The newest transcript in a kernel session's directory; pi names files by creation time. */
function latestTranscript(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const last = files.at(-1);
  return last === undefined ? null : join(dir, last);
}

/** Whether a user message already in the transcript contains `marker`. */
function transcriptHolds(sessionManager: SessionManager, marker: string): boolean {
  return sessionManager.getEntries().some((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return false;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
    return text.includes(marker);
  });
}

/** Ends a pi run early from inside a tool call, for a deferred call or a failed `invoke`. */
class Stop {
  session: AgentSession | null = null;
  deferred: CallId | null = null;
  failure: { error: unknown } | null = null;
  stopping: Promise<void> | null = null;

  /** Only the first deferred call of a run counts. */
  defer(callId: CallId): void {
    this.deferred ??= callId;
    this.abort();
  }

  /** `invoke` itself failed (the kernel's store, or the process is going down): no more model turns. */
  fail(error: unknown): void {
    this.failure ??= { error };
    this.abort();
  }

  private abort(): void {
    // Not awaited here: abort() waits for the session to go idle, which needs this tool call to return first.
    this.stopping ??= this.session?.abort() ?? null;
  }
}

/**
 * Kernel call ids for one run. The kernel keys journal entries, deferred calls and answers by call id, but
 * providers do not all make ids unique: some send none, some derive one from the call's position. So the
 * id is prefixed with the session, and a provider id that is empty or already appeared earlier in this
 * session's transcript gets its occurrence number. Numbering follows the transcript and the order pi starts
 * calls, so it is the same whenever the same transcript is replayed; a unique id keeps its plain form.
 */
class CallIds {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly sessionId: string,
    sessionManager: SessionManager,
  ) {
    for (const entry of sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const c of entry.message.content) if (c.type === "toolCall") this.count(c.id);
    }
  }

  next(toolCallId: string): CallId {
    const n = this.count(toolCallId);
    return n === 0 && toolCallId !== "" ? `${this.sessionId}:${toolCallId}` : `${this.sessionId}:${toolCallId}#${n}`;
  }

  private count(id: string): number {
    const n = this.seen.get(id) ?? 0;
    this.seen.set(id, n + 1);
    return n;
  }
}

/** A kernel tool as a pi tool: the only way pi can execute anything is through `invoke`. */
function toPiTool(tool: Tool, ids: CallIds, stop: Stop): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // pi validates tool arguments as plain JSON Schema whatever built it (docs/extensions.md); TSchema is only its type.
    parameters: tool.schema as TSchema,
    async execute(toolCallId, params) {
      const callId = ids.next(toolCallId);
      let result: ToolResult;
      try {
        result = await tool.invoke(callId, params);
      } catch (err) {
        stop.fail(err);
        throw err;
      }
      switch (result.status) {
        case "ok":
          return { details: undefined, ...okToPi(result.output) };
        case "error":
          // pi turns a thrown error into an error tool result carrying the message.
          throw new Error(result.error);
        case "unknown":
          return { details: undefined, ...text(result.message) };
        case "deferred":
          stop.defer(callId);
          return { details: undefined, ...text(DEFERRED_PLACEHOLDER) };
      }
    },
  };
}

/** No discovery: no extensions, skills, prompt templates or context files, and one fixed system prompt. */
function fixedResources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** pi settles normally after a failed model request; the failure is only on its last assistant message. */
function modelFailure(session: AgentSession): string | null {
  const last = session.messages.findLast((m) => m.role === "assistant");
  if (last?.role !== "assistant" || last.stopReason !== "error") return null;
  return last.errorMessage ?? "unknown error";
}
