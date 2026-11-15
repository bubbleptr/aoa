import type { AgentRuntime, CallId, RunInput, RunResult, Tool, ToolResult } from "@aoa/kernel";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { renderUserMessage } from "./prompt.ts";
import { okToPi, text } from "./results.ts";

export type PiRuntimeConfig = {
  /** pi provider id, e.g. `anthropic`. */
  provider: string;
  modelId: string;
  /** Held in memory by pi's model runtime; never written to disk or shown to the model. */
  apiKey?: string;
  agentDir: string;
  /** Where the JSONL transcripts live; a run's `sessionRef` is its file path. */
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

export function piRuntime(config: PiRuntimeConfig): AgentRuntime {
  let models: Promise<ModelRuntime> | null = null;
  const modelRuntime = () => (models ??= createModelRuntime(config));
  return {
    run: async (input) => {
      try {
        return await run(config, await modelRuntime(), input);
      } catch (err) {
        // Rethrow as is when there is nothing to hide: the kernel tells a simulated crash by its class.
        const message = err instanceof Error ? err.message : String(err);
        if (config.apiKey && message.includes(config.apiKey)) throw new Error(message.split(config.apiKey).join("[redacted]"));
        throw err;
      }
    },
  };
}

async function createModelRuntime(config: PiRuntimeConfig): Promise<ModelRuntime> {
  // In-memory credentials and no models.json: nothing is read from or written to the user's ~/.pi.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const p of config.providers ?? []) runtime.registerNativeProvider(p);
  if (config.apiKey) await runtime.setRuntimeApiKey(config.provider, config.apiKey);
  return runtime;
}

async function run(config: PiRuntimeConfig, models: ModelRuntime, input: RunInput): Promise<RunResult> {
  const model = models.getModel(config.provider, config.modelId);
  if (!model) throw new Error(`pi has no model ${config.provider}/${config.modelId}`);

  const cwd = input.session.workdir ?? config.cwd;
  const sessionManager =
    input.session.ref === null
      ? SessionManager.create(cwd, config.sessionsDir)
      : SessionManager.open(input.session.ref, config.sessionsDir, cwd);

  const stop = new Stop();
  const { session } = await createAgentSession({
    cwd,
    agentDir: config.agentDir,
    model,
    modelRuntime: models,
    resourceLoader: fixedResources(config.systemPrompt),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    noTools: "builtin",
    customTools: input.tools.map((t) => toPiTool(t, stop)),
  });
  stop.session = session;

  try {
    await session.prompt(renderUserMessage(input), { expandPromptTemplates: false });
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

/** A kernel tool as a pi tool: the only way pi can execute anything is through `invoke`. */
function toPiTool(tool: Tool, stop: Stop): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // pi validates tool arguments as plain JSON Schema whatever built it (docs/extensions.md); TSchema is only its type.
    parameters: tool.schema as TSchema,
    async execute(toolCallId, params) {
      let result: ToolResult;
      try {
        result = await tool.invoke(toolCallId, params);
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
          stop.defer(toolCallId);
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
