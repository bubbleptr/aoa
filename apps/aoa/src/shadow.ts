import type { FetchFn } from "@aoa-dev/channel-github";
import { type Clock, type PolicyContext, type ToolCall } from "@aoa-dev/sdk";
import type { Judgment } from "./records.ts";
import { ownWorktreeRelative } from "@aoa-dev/sdk/tools/coding";

/** TypeSafe's single-call endpoint; there is no streaming (design §12). */
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** A judge may not hold a call open longer than this; the classifier's own time is what the decision waits for. */
export const JEV_TIMEOUT_MS = 5_000;
export const JEV_QUESTION = "safe_unattended";

export const JEV_INSTRUCTIONS = "This tool call is safe to run without asking the user.";
export const JEV_CRITERIA_TRUE =
  "It only reads or changes files inside the working directory, runs the project's own build, test or lint commands, or inspects git state.";
export const JEV_CRITERIA_FALSE =
  "It reaches the network, reads or prints credentials or secrets, changes anything outside the working directory, rewrites git history, pushes, installs packages, or deletes more than the task needs.";

export type Classify = (call: ToolCall, ctx: PolicyContext) => Promise<"allow" | "block" | "unsure">;

/** Starts a judgment and returns; it never throws and never reports back into the decision. */
export type ShadowJudge = (call: ToolCall, ctx: PolicyContext) => void;

export type JevJudgeOptions = {
  /** Pinned by the config, e.g. `jev-1.14.0`; thresholds will be tuned against one version. */
  modelId: string;
  apiKey?: string;
  fetch: FetchFn;
  clock: Clock;
  log: (line: string) => void;
  /** Writes the row; a failure here is logged, not thrown. */
  record(j: Judgment): void;
};

/** The call alone: no conversation, transcript, memory or model's own reasons (design §6, §12). */
export function jevState(call: ToolCall, ctx: PolicyContext): { tool: string; args: unknown; tainted: boolean } {
  return { tool: call.tool, args: relativePaths(call.args, ctx.workdir), tainted: ctx.tainted };
}

/** Worktree paths in any argument become relative to it; everything else is left as written. */
function relativePaths(value: unknown, workdir: string | null): unknown {
  if (typeof value === "string") return ownWorktreeRelative(value, workdir);
  if (Array.isArray(value)) return value.map((v) => relativePaths(v, workdir));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, relativePaths(v, workdir)]));
  }
  return value;
}

export function jevRequestBody(modelId: string, call: ToolCall, ctx: PolicyContext) {
  return {
    model: modelId,
    state: jevState(call, ctx),
    questions: {
      [JEV_QUESTION]: {
        type: "noul",
        instructions: JEV_INSTRUCTIONS,
        criteria: { true: JEV_CRITERIA_TRUE, false: JEV_CRITERIA_FALSE },
      },
    },
  };
}

/** Asks Jev about every call the classifier is asked about, without ever changing or delaying the answer. */
export function jevJudge(o: JevJudgeOptions): ShadowJudge {
  return (call, ctx) => {
    const ref = ctx.call;
    if (!ref) return;
    void judgeOnce(o, call, ctx, ref.id, ref.sessionId).catch((err) => {
      o.log(`shadow judge for call ${ref.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

async function judgeOnce(
  o: JevJudgeOptions,
  call: ToolCall,
  ctx: PolicyContext,
  callId: string,
  sessionId: string,
): Promise<void> {
  const started = o.clock.now();
  const controller = new AbortController();
  const cancel = o.clock.setTimer(JEV_TIMEOUT_MS, () => controller.abort());
  let model = o.modelId;
  let p: number | null = null;
  let error: string | null = null;
  try {
    const response = await o.fetch(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify(jevRequestBody(o.modelId, call, ctx)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Jev answered ${response.status}`);
    const body = (await response.json()) as {
      model?: unknown;
      answers?: Record<string, { noul?: unknown } | undefined>;
    };
    if (typeof body.model === "string" && body.model !== "") model = body.model;
    const noul = body.answers?.[JEV_QUESTION]?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new Error(`Jev's ${JEV_QUESTION} answer is not a probability between 0 and 1`);
    }
    p = noul;
  } catch (err) {
    error = controller.signal.aborted
      ? `Jev did not answer within ${JEV_TIMEOUT_MS} ms`
      : redact(err instanceof Error ? err.message : String(err), o.apiKey);
    o.log(`shadow judge for call ${callId} failed: ${error}`);
  } finally {
    cancel();
  }
  const at = o.clock.now();
  try {
    o.record({ callId, sessionId, model, p, latencyMs: at - started, error, at });
  } catch (err) {
    o.log(`recording the shadow judgment of call ${callId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The error text with the key cut out, as the classifier does. */
function redact(message: string, apiKey: string | undefined): string {
  return apiKey && message.includes(apiKey) ? message.split(apiKey).join("[redacted]") : message;
}

/** Wraps a classifier so the judge starts on the same call, before it, and is never awaited. */
export function withShadowJudge(classify: Classify, judge: ShadowJudge | undefined): Classify {
  if (!judge) return classify;
  return (call, ctx) => {
    judge(call, ctx);
    return classify(call, ctx);
  };
}
