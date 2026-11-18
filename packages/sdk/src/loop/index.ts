import type { CallId, KernelRuntime, RunInput, RunResult, SessionId, Tool, ToolResult } from "../kernel/index.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eventMarker, renderUserMessage } from "../prompt.ts";
import { resultText } from "../results.ts";

export type LoopToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type LoopTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; text?: string; reasoning?: string; toolCalls?: LoopToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; isError?: boolean };

export type LoopToolSpec = {
  name: string;
  description: string;
  schema: unknown;
};

export type LoopCompleteInput = {
  systemPrompt: string;
  messages: readonly LoopTurn[];
  tools: readonly LoopToolSpec[];
  signal: AbortSignal;
  /** Emits live streaming deltas (`text` or `reasoning`) onto the run's activity stream. */
  emit: (a: { kind: "text" | "reasoning"; delta: string }) => void;
};

export type LoopCompleteOutput = {
  text?: string;
  reasoning?: string;
  toolCalls?: LoopToolCall[];
};

export type LoopComplete = (input: LoopCompleteInput) => Promise<LoopCompleteOutput>;

export interface TranscriptHandle {
  readonly ref: string;
  readonly entries: readonly LoopTurn[];
  append(turn: LoopTurn): Promise<void> | void;
}

export interface TranscriptStore {
  /** Opens `ref` when given, or recovers/creates the transcript of `sessionId`. */
  open(sessionId: SessionId, ref: string | null): Promise<TranscriptHandle> | TranscriptHandle;
}

export type LoopRuntimeConfig = {
  /** Fixed across runs so prompt caches hold; per-run resident context and events go into user turns. */
  systemPrompt: string;
  /** One model turn: takes messages and tool schemas, returns assistant text and/or tool calls. */
  complete: LoopComplete;
  /** Persists transcripts across runs; defaults to `memoryTranscripts()` (use `dirTranscripts(dir)` across restarts). */
  transcripts?: TranscriptStore;
  /** Cap on model turns within one run; default 64. */
  maxTurns?: number;
};

const DEFAULT_MAX_TURNS = 64;
const DEFERRED_PLACEHOLDER =
  "This call needs the user's decision. It has not been executed. The run stops here; the answer arrives in a later message.";

/** In-memory transcript store, keyed by session id; suitable for ephemeral processes and tests. */
export function memoryTranscripts(): TranscriptStore {
  const byRef = new Map<string, LoopTurn[]>();
  const latestBySession = new Map<SessionId, string>();
  return {
    open(sessionId, ref) {
      const key = ref ?? latestBySession.get(sessionId) ?? `mem:${sessionId}:${crypto.randomUUID()}`;
      let entries = byRef.get(key);
      if (!entries) {
        entries = [];
        byRef.set(key, entries);
      }
      latestBySession.set(sessionId, key);
      return {
        ref: key,
        get entries() {
          return entries!;
        },
        append(turn) {
          entries!.push(turn);
        },
      };
    },
  };
}

/**
 * Append-only JSONL transcripts on disk, one directory per kernel session. Recovers the latest transcript of a session
 * when a previous attempt crashed or failed before the kernel recorded `sessionRef`.
 */
export function dirTranscripts(sessionsDir: string): TranscriptStore {
  return {
    open(sessionId, ref) {
      const dir = join(sessionsDir, encodeURIComponent(sessionId));
      mkdirSync(dir, { recursive: true });
      const file = ref ?? latestFile(dir) ?? join(dir, `${Date.now()}-${crypto.randomUUID()}.jsonl`);
      const entries: LoopTurn[] = existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as LoopTurn)
        : [];
      if (!existsSync(file)) appendFileSync(file, "");
      return {
        ref: file,
        get entries() {
          return entries;
        },
        append(turn) {
          appendFileSync(file, `${JSON.stringify(turn)}\n`);
          entries.push(turn);
        },
      };
    },
  };
}

function latestFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const last = files.at(-1);
  return last === undefined ? null : join(dir, last);
}

/**
 * Dependency-free tier-1 `KernelRuntime` adapter: connects any chat-completion client (OpenAI, Anthropic, Vercel AI
 * SDK, local models, plain `fetch`) to aoa's tool journal, deferred approvals, retry detection and activity stream.
 */
export function loopRuntime(config: LoopRuntimeConfig): KernelRuntime {
  const transcripts = config.transcripts ?? memoryTranscripts();
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  return {
    kind: "kernel",
    run: (input) => runLoop(config, transcripts, maxTurns, input),
  };
}

async function runLoop(
  config: LoopRuntimeConfig,
  transcripts: TranscriptStore,
  maxTurns: number,
  input: RunInput,
): Promise<RunResult> {
  input.signal.throwIfAborted();
  const handle = await transcripts.open(input.session.id, input.session.ref);
  const retry = input.events.some((e) =>
    handle.entries.some((t) => t.role === "user" && t.content.includes(eventMarker(e))),
  );

  const ids = new CallIds(input.session.id, handle.entries);
  const toolMap = new Map<string, Tool>(input.tools.map((t) => [t.name, t]));
  const toolSpecs: LoopToolSpec[] = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
  }));

  await handle.append({ role: "user", content: renderUserMessage(input, retry) });

  for (let turn = 0; turn < maxTurns; turn++) {
    input.signal.throwIfAborted();
    let streamedText = false;
    let streamedReasoning = false;
    const emit = (a: { kind: "text" | "reasoning"; delta: string }) => {
      if (a.delta === "") return;
      if (a.kind === "text") streamedText = true;
      else streamedReasoning = true;
      input.emit?.(a);
    };

    const out = await config.complete({
      systemPrompt: config.systemPrompt,
      messages: handle.entries,
      tools: toolSpecs,
      signal: input.signal,
      emit,
    });
    input.signal.throwIfAborted();

    if (!streamedReasoning && out.reasoning) input.emit?.({ kind: "reasoning", delta: out.reasoning });
    if (!streamedText && out.text) input.emit?.({ kind: "text", delta: out.text });

    const calls = out.toolCalls ?? [];
    await handle.append({
      role: "assistant",
      ...(out.text !== undefined ? { text: out.text } : {}),
      ...(out.reasoning !== undefined ? { reasoning: out.reasoning } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });

    if (calls.length === 0) {
      const reply = out.text?.trim();
      return {
        end: { kind: "silent" },
        sessionRef: handle.ref,
        ...(reply ? { reply } : {}),
      };
    }

    let deferred: CallId | null = null;
    for (const call of calls) {
      input.signal.throwIfAborted();
      const kernelCallId = ids.next(call.id);
      const tool = toolMap.get(call.name);
      if (!tool) {
        await handle.append({
          role: "tool",
          callId: call.id,
          name: call.name,
          content: `Unknown tool: ${call.name}`,
          isError: true,
        });
        continue;
      }
      const result: ToolResult = await tool.invoke(kernelCallId, call.args);
      switch (result.status) {
        case "ok":
          await handle.append({ role: "tool", callId: call.id, name: call.name, content: resultText(result.output) });
          break;
        case "error":
          await handle.append({ role: "tool", callId: call.id, name: call.name, content: result.error, isError: true });
          break;
        case "unknown":
          await handle.append({ role: "tool", callId: call.id, name: call.name, content: result.message });
          break;
        case "deferred":
          deferred ??= kernelCallId;
          await handle.append({ role: "tool", callId: call.id, name: call.name, content: DEFERRED_PLACEHOLDER });
          break;
      }
    }

    if (deferred !== null) {
      return { end: { kind: "deferred", callId: deferred }, sessionRef: handle.ref };
    }
  }

  throw new Error(`loopRuntime exceeded maxTurns (${maxTurns})`);
}

class CallIds {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly sessionId: string,
    entries: readonly LoopTurn[],
  ) {
    for (const entry of entries) {
      if (entry.role !== "assistant" || !entry.toolCalls) continue;
      for (const c of entry.toolCalls) this.count(c.id);
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
