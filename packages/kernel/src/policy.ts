import type { CallId, Decision, Risk, SessionId } from "./types.ts";

export type { Risk } from "./types.ts";

/** What the policy sees of a call. Nothing the model says about its own safety is part of it (spec §6.2). */
export type ToolCall = { tool: string; args: unknown };

export type PolicyContext = {
  /** The session has taken content from someone other than the user (design §6). */
  tainted: boolean;
  /** The session's working directory, so a rule can tell paths inside it from paths outside. */
  workdir: string | null;
  /** The call's identity, for a shadow judge that records under it. Absent when the policy runs on its own. */
  call?: { id: CallId; sessionId: SessionId };
};

/** A rule with an opinion returns a decision; `null` passes the call to the next rule. */
export type Rule = { name: string; match(call: ToolCall, ctx: PolicyContext): Decision | null };

export type PolicyConfig = {
  /** Per tool name; a tool not listed is `high`. */
  /** Overrides the tiers the tools carry. */
  risk?: Record<string, Risk>;
  /** Checked in order, before the risk tier. */
  rules?: Rule[];
  /** Judges `medium` calls. Missing, throwing or `unsure` means the user decides. */
  classify?: (call: ToolCall, ctx: PolicyContext) => Promise<"allow" | "block" | "unsure">;
};

export type Verdict = { decision: Decision; basis: string };

/** Decision order: first rule with an opinion, then the risk tier, `medium` through the classifier (spec §6.3). */
export async function decide(policy: PolicyConfig | undefined, call: ToolCall, ctx: PolicyContext, toolRisk?: Risk): Promise<Verdict> {
  // No policy is no rules, no overrides and no classifier, never "allow everything" (spec §6.2: unknown calls defer).
  policy ??= {};
  for (const rule of policy.rules ?? []) {
    const decision = rule.match(call, ctx);
    if (decision) return { decision, basis: `rule:${rule.name}` };
  }
  const risk = policy.risk?.[call.tool] ?? toolRisk ?? "high";
  if (risk === "low") return { decision: "allow", basis: "risk:low" };
  if (risk === "high") return { decision: "defer", basis: "risk:high" };
  if (!policy.classify) return { decision: "defer", basis: "reviewer:missing" };
  let verdict: string;
  try {
    verdict = await policy.classify(call, ctx);
  } catch {
    return { decision: "defer", basis: "reviewer:error" };
  }
  const decision: Decision = verdict === "allow" ? "allow" : verdict === "block" ? "block" : "defer";
  return { decision, basis: `reviewer:${verdict}` };
}
