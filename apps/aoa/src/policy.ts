import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BRANCH_LIST_FLAGS, commandOf, defaultRules, gitInvocations, type PolicyConfig, type Risk, type Rule } from "@aoa/kernel";

const LOW = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "memory_read",
  "memory_write",
  "memory_list",
  "notify",
  "wake_me_at",
  "cancel_wake",
  "follow",
  "github_comment",
  "github_open_pr",
  "send_to",
];
const MEDIUM = ["bash", "git_push"];

const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

/** The path with every existing part resolved through symlinks, so a link inside the worktree cannot lead out of it. */
function canonical(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Every path a file tool's call can reach: its `path`, and the glob that grep and find resolve against it. */
function reachedPaths(tool: string, args: Record<string, unknown>, workdir: string): string[] {
  const base = resolve(workdir, expandHome(typeof args.path === "string" ? args.path : "."));
  const globKey = tool === "grep" ? "glob" : tool === "find" ? "pattern" : null;
  const glob = globKey === null ? undefined : args[globKey];
  return typeof glob === "string" ? [base, resolve(base, expandHome(glob))] : [base];
}

/** A file tool reaching outside the session's worktree waits for the user. */
export const outsideWorktree: Rule = {
  name: "outside-worktree",
  match(call, ctx) {
    if (!FILE_TOOLS.has(call.tool)) return null;
    if (ctx.workdir === null) return "defer";
    const args = typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
    const root = canonical(ctx.workdir);
    return reachedPaths(call.tool, args, ctx.workdir).every((p) => inside(root, canonical(p))) ? null : "defer";
  },
};

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
 * The agent's policy: the built-in risk table under the config's overrides, the worktree rule, the role's `ahead`
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
  const risk: Record<string, Risk> = {
    ...Object.fromEntries(LOW.map((t) => [t, "low" as const])),
    ...Object.fromEntries(MEDIUM.map((t) => [t, "medium" as const])),
    ...o.risk,
  };
  return {
    risk,
    rules: [outsideWorktree, ...(o.ahead ?? []), ...defaultRules, ...(o.rules ?? [])],
    ...(o.classify ? { classify: o.classify } : {}),
  };
}
