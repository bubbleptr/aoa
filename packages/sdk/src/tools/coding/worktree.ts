import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Rule } from "../../kernel/index.ts";

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
