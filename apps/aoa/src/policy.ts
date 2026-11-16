import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultRules, gitInvocations, type PolicyConfig, type Risk, type Rule } from "@aoa/kernel";

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
    if (call.tool !== "bash" || typeof call.args !== "object" || call.args === null) return null;
    const command = (call.args as { command?: unknown }).command;
    return typeof command === "string" && gitInvocations(command).some((g) => g.sub === "push") ? "defer" : null;
  },
};

/**
 * The agent's policy: the built-in risk table under the config's overrides, the worktree rule, the kernel's rules,
 * then the mode's `rules`. Those come after the kernel's so its blocks (a force push, sudo) stay blocks instead of
 * becoming questions; they still come before the risk tier, so the classifier never sees what they defer.
 */
export function agentPolicy(o: { risk?: Record<string, Risk>; classify?: PolicyConfig["classify"]; rules?: Rule[] }): PolicyConfig {
  const risk: Record<string, Risk> = {
    ...Object.fromEntries(LOW.map((t) => [t, "low" as const])),
    ...Object.fromEntries(MEDIUM.map((t) => [t, "medium" as const])),
    ...o.risk,
  };
  return { risk, rules: [outsideWorktree, ...defaultRules, ...(o.rules ?? [])], ...(o.classify ? { classify: o.classify } : {}) };
}
