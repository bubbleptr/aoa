import { githubTools } from "@aoa-dev/channel-github";
import { builtinToolRisk, type PolicyConfig, type Risk, type Rule, type ToolDef } from "@aoa-dev/sdk";
import { codingTools } from "@aoa-dev/pi";
import { BRANCH_LIST_FLAGS, codingRules, commandOf, gitInvocations, outsideWorktree } from "@aoa-dev/sdk/tools/coding";

/**
 * Local mode: the branch stays on this machine until the user merges it, so any `git push` in a bash call waits
 * for them. A convention, not isolation: the agent's shell is the user's, and text matching can be evaded.
 */
export const deferPush: Rule = {
  name: "local-push",
  match(call) {
    const command = commandOf(call);
    return command !== null && gitInvocations(command).some((g) => g.sub === "push") ? "defer" : null;
  },
};

/** git subcommands that move a ref or rewrite the work tree's history. `merge-tree` and `restore` are not among them. */
const HISTORY_CHANGES = new Set(["commit", "push", "merge", "rebase", "reset", "cherry-pick", "revert", "tag", "am", "apply", "stash", "checkout", "switch", "worktree"]);

/**
 * A review agent reads and runs, but never changes refs or history: those git calls are blocked, not deferred, so the
 * user is never asked to let a reviewer commit. A convention, not isolation, like `deferPush`.
 */
export const reviewReadOnly: Rule = {
  name: "review-read-only",
  match(call) {
    const command = commandOf(call);
    if (command === null) return null;
    const changes = gitInvocations(command).some(
      (g) => g.sub !== undefined && (HISTORY_CHANGES.has(g.sub) || (g.sub === "branch" && !g.args.every((a) => BRANCH_LIST_FLAGS.has(a)))),
    );
    return changes ? "block" : null;
  },
};

/**
 * The agent's policy: the config's risk overrides (each tool carries its own tier), the worktree rule, the role's `ahead`
 * rules, the kernel's rules, then the mode's `rules`. The role's rules come first so their blocks win over the
 * kernel's deferrals (a commit naming a path under `~/.aoa` would otherwise become a question). The mode's come after the kernel's so its blocks (a force
 * push, sudo) stay blocks instead of becoming questions; they still come before the risk tier, so the classifier
 * never sees what they defer.
 */
export function agentPolicy(o: {
  risk?: Record<string, Risk>;
  classify?: PolicyConfig["classify"];
  ahead?: Rule[];
  rules?: Rule[];
}): PolicyConfig {
  return {
    // Each tool carries its own tier; the config's table overrides it.
    risk: { ...o.risk },
    rules: [outsideWorktree, ...(o.ahead ?? []), ...codingRules, ...(o.rules ?? [])],
    ...(o.classify ? { classify: o.classify } : {}),
  };
}

/**
 * Every tool aoa can give an agent, by name, with the tier its definition declares. For deciding a call known only by
 * its tool name, as the eval's replay and the policy tests do; a live call gets its tool's tier from the tool itself.
 */
export function toolRisk(): Record<string, Risk> {
  const defs: ToolDef[] = [
    ...codingTools(),
    ...githubTools({ owner: "", repo: "", userLogin: "", botLogin: "", appId: "", installationId: "", privateKeyPath: "" }),
  ];
  return { ...builtinToolRisk(), ...Object.fromEntries(defs.flatMap((d) => (d.risk ? [[d.name, d.risk]] : []))) };
}
