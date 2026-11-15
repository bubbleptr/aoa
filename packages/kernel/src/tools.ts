import type { CrashHook } from "./crash.ts";
import type { Clock, Store } from "./ports.ts";
import type { CallId, InboxId, SessionId, Tool, ToolDef, ToolResult } from "./types.ts";

export type ToolContext = {
  store: Store;
  clock: Clock;
  inboxId: InboxId;
  sessionId: SessionId;
  crash: CrashHook;
  /** Throws if this process has (simulated) crashed, so nothing more is written. */
  assertAlive: () => void;
};

const UNKNOWN_OUTCOME: ToolResult = {
  status: "unknown",
  message:
    "This call was started before a crash and its result was not recorded, so it may or may not have taken effect. Check the external state before deciding whether to call it again.",
};

/**
 * Wraps registered tools so every call goes through the journal keyed by `(session, callId)`.
 * A rerun of the same session replays recorded results instead of executing again (design §5).
 */
export function wrapTools(defs: ToolDef[], ctx: ToolContext): Tool[] {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    schema: def.schema,
    invoke: (callId, args) => invoke(def, ctx, callId, args),
  }));
}

async function invoke(def: ToolDef, ctx: ToolContext, callId: CallId, args: unknown): Promise<ToolResult> {
  const { store, clock, inboxId, sessionId, crash, assertAlive } = ctx;

  assertAlive();
  const prior = store.tx((t) => t.getJournal(sessionId, callId));
  if (prior?.result) return prior.result;
  if (prior && !def.idempotent) return UNKNOWN_OUTCOME;

  const denied = authorize(def, args);
  if (denied) return denied;

  if (!prior) {
    store.tx((t) => t.recordIntent({ inboxId, sessionId, callId, tool: def.name, args, at: clock.now() }));
  }
  const result = await execute(def, args);
  crash("after_tool_exec");
  assertAlive();
  store.tx((t) => t.recordResult(sessionId, callId, result, clock.now()));
  crash("after_tool_result");
  return result;
}

/** The permission check (spec §6.3) goes here; until it exists every call is allowed. */
function authorize(_def: ToolDef, _args: unknown): ToolResult | null {
  return null;
}

async function execute(def: ToolDef, args: unknown): Promise<ToolResult> {
  try {
    return { status: "ok", output: await def.execute(args) };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
