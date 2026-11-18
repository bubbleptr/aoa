import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRunner } from "@aoa-dev/channel-github";
import type { Session } from "@aoa-dev/sdk";

/**
 * The branch of an implementing agent's session: `aoa/<first 8 of its id>` for the default agent, so existing
 * branches keep their names, and `aoa/<agent>/<first 8>` for a named one.
 */
export function sessionBranch(agent: string | null, sessionId: string): string {
  return agent === null ? `aoa/${sessionId.slice(0, 8)}` : `aoa/${agent}/${sessionId.slice(0, 8)}`;
}

export type Worktrees = {
  /**
   * The session's worktree, created unless it already exists. With `branchOf`, on the session's own branch: from a
   * freshly fetched `origin/<base>` when `fromOrigin`, else from the local `<base>` (local mode, where a repo may have
   * no remote). Without it (a review agent), detached at the commit `branch` names, or at `<base>` without one: the
   * branch itself is checked out in its implementer's worktree, and git allows that only once.
   */
  prepare(session: Session, branch?: string): Promise<{ workdir: string }>;
  remove(workdir: string): Promise<void>;
  /** The commit a local branch of the repository points at; null if there is no such branch. */
  commitOf(branch: string): Promise<string | null>;
};

export function worktrees(o: {
  repo: string;
  base: string;
  root: string;
  runGit: GitRunner;
  fromOrigin: boolean;
  branchOf: ((sessionId: string) => string) | null;
}): Worktrees {
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

  // Under refs/heads/, so a name from the model can never be read as an option or another kind of ref.
  async function commitOf(branch: string): Promise<string | null> {
    const r = await o.runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: o.repo, env: {} });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  return {
    async prepare(session, reviewed) {
      const dir = join(o.root, session.id);
      // The kernel calls this again after a crash, and a reopened session may still have its branch: reuse both.
      if (existsSync(dir)) {
        if (!(await isWorktree(dir))) throw new Error(`${dir} exists but is not a worktree of ${o.repo}`);
        return { workdir: realpathSync(dir) };
      }
      if (o.fromOrigin) await git(["fetch", "origin", o.base]);
      mkdirSync(dirname(dir), { recursive: true });
      if (o.branchOf === null) {
        const commit = reviewed === undefined ? (await git(["rev-parse", "--verify", `${o.base}^{commit}`])).trim() : await commitOf(reviewed);
        if (commit === null) throw new Error(`there is no branch ${reviewed} to review in ${o.repo}`);
        await git(["worktree", "add", "--detach", dir, commit]);
        return { workdir: realpathSync(dir) };
      }
      const branch = o.branchOf(session.id);
      const hasBranch = (await commitOf(branch)) !== null;
      await git(hasBranch ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, o.fromOrigin ? `origin/${o.base}` : o.base]);
      return { workdir: realpathSync(dir) };
    },

    commitOf,

    async remove(workdir) {
      if (existsSync(workdir)) await git(["worktree", "remove", "--force", workdir]);
      else await git(["worktree", "prune"]);
    },
  };
}
