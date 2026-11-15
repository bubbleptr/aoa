import type { CrashHook } from "./crash.ts";
import { DEFER_TTL_MS, deferInTx, isQuestionTool } from "./deferred.ts";
import { decide, type PolicyConfig, type Verdict } from "./policy.ts";
import type { Clock, Store } from "./ports.ts";
import type { CallId, InboxId, SessionId, Tool, ToolDef, ToolExecContext, ToolResult } from "./types.ts";

export type ToolContext = {
  store: Store;
  clock: Clock;
  inboxId: InboxId;
  sessionId: SessionId;
  workdir: string | null;
  policy?: PolicyConfig;
  crash: CrashHook;
  /** Throws if this process has (simulated) crashed, so nothing more is written. */
  assertAlive: () => void;
};

export const UNKNOWN_OUTCOME: ToolResult = {
  status: "unknown",
  message:
    "This call was started before a crash and its result was not recorded, so it may or may not have taken effect. Check the external state before deciding whether to call it again.",
};

const DEFERRED: ToolResult = { status: "deferred" };

/**
 * Wraps registered tools so every call is decided by the policy (spec §6.3) and goes through the journal
 * keyed by `(session, callId)`. A rerun of the same session replays recorded results instead of executing again (design §5).
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
  const { store, clock, inboxId, sessionId, assertAlive } = ctx;

  assertAlive();
  const prior = store.tx((t) => t.getJournal(sessionId, callId));
  if (prior?.result) return prior.result;
  // An intent is only ever recorded for an authorized call, so finishing it needs no second decision.
  if (prior) return def.idempotent ? executeRecorded(def, ctx, callId, args) : UNKNOWN_OUTCOME;

  const question = isQuestionTool(def);
  if (question && typeof (args as { question?: unknown } | null)?.question !== "string") {
    return { status: "error", error: "question must be a string" };
  }
  const tainted = store.tx((t) => t.getSession(sessionId)!.tainted);
  const verdict: Verdict = question
    ? { decision: "defer", basis: "ask_user" }
    : await decide(ctx.policy, { tool: def.name, args }, { tainted });

  assertAlive();
  const settled = store.tx((t): ToolResult | null => {
    // One pending call per session: anything after it waits too, and creates nothing.
    if (t.getSession(sessionId)!.pending !== null) return DEFERRED;
    const now = clock.now();
    t.recordDecision({ callId, sessionId, tool: def.name, decision: verdict.decision, basis: verdict.basis, at: now });
    if (verdict.decision === "defer") {
      deferInTx(t, {
        callId,
        sessionId,
        inboxId,
        tool: def.name,
        args,
        kind: question ? "question" : "approval",
        requestedAt: now,
        expiresAt: now + DEFER_TTL_MS,
      });
      return DEFERRED;
    }
    t.recordIntent({ inboxId, sessionId, callId, tool: def.name, args, at: now });
    if (verdict.decision === "allow") return null;
    const blocked: ToolResult = { status: "error", error: `Blocked by policy: ${verdict.basis}. Find another way.` };
    t.recordResult(sessionId, callId, blocked, now);
    return blocked;
  });
  return settled ?? executeRecorded(def, ctx, callId, args);
}

/** Executes a call whose intent is already journaled, then records its result. */
export async function executeRecorded(def: ToolDef, ctx: ToolContext, callId: CallId, args: unknown): Promise<ToolResult> {
  const { store, clock, sessionId, workdir, crash, assertAlive } = ctx;
  const result = await execute(def, args, { sessionId, callId, workdir });
  crash("after_tool_exec");
  assertAlive();
  store.tx((t) => t.recordResult(sessionId, callId, result, clock.now()));
  crash("after_tool_result");
  return result;
}

async function execute(def: ToolDef, args: unknown, ctx: ToolExecContext): Promise<ToolResult> {
  try {
    return { status: "ok", output: await def.execute(args, ctx) };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
