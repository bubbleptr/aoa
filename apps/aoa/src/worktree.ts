import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRunner } from "@aoa/channel-github";
import type { Session } from "@aoa/kernel";

export type Worktrees = {
  /**
   * The session's worktree on branch `aoa/<first 8 of its id>`, created unless it already exists: from a freshly
   * fetched `origin/<base>` when `fromOrigin`, else from the local `<base>` (local mode, where a repo may have no remote).
   */
  prepare(session: Session): Promise<{ workdir: string }>;
  remove(workdir: string): Promise<void>;
};

export function worktrees(o: { repo: string; base: string; root: string; runGit: GitRunner; fromOrigin: boolean }): Worktrees {
  const git = async (args: string[]) => {
    const r = await o.runGit(args, { cwd: o.repo, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0) throw new Error(`git ${args[0]} exited with ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };

  async function isWorktree(dir: string): Promise<boolean> {
    const real = realpathSync(dir);
    const listed = (await git(["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
    return listed.some((p) => existsSync(p) && realpathSync(p) === real);
  }

  return {
    async prepare(session) {
      const dir = join(o.root, session.id);
      const branch = `aoa/${session.id.slice(0, 8)}`;
      // The kernel calls this again after a crash, and a reopened session may still have its branch: reuse both.
      if (existsSync(dir)) {
        if (!(await isWorktree(dir))) throw new Error(`${dir} exists but is not a worktree of ${o.repo}`);
        return { workdir: realpathSync(dir) };
      }
      if (o.fromOrigin) await git(["fetch", "origin", o.base]);
      mkdirSync(dirname(dir), { recursive: true });
      const hasBranch = (await o.runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: o.repo, env: {} })).code === 0;
      await git(hasBranch ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, o.fromOrigin ? `origin/${o.base}` : o.base]);
      return { workdir: realpathSync(dir) };
    },

    async remove(workdir) {
      if (existsSync(workdir)) await git(["worktree", "remove", "--force", workdir]);
      else await git(["worktree", "prune"]);
    },
  };
}
