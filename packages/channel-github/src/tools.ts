import type { ToolDef } from "@aoa/kernel";
import { type GitHubConfig, GitHubClient, resolve } from "./client.ts";
import { threadKey, threadNumber } from "./thread.ts";

export type GitRunner = (
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type GitHubToolsConfig = GitHubConfig & {
  /** Runs `git` with these arguments; `env` is added to the host's environment. */
  runGit?: GitRunner;
};

type RepoJson = { default_branch: string; clone_url: string };
type PullJson = { number: number; html_url: string; head: { ref: string } };
type CommentJson = { id: number; html_url: string };

/** Runs the `git` on the host's PATH. */
export const runGitWithBun: GitRunner = async (args, { cwd, env }) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export function githubTools(config: GitHubToolsConfig): ToolDef[] {
  const cfg = resolve(config);
  const runGit = config.runGit ?? runGitWithBun;
  const client = new GitHubClient(cfg);
  const repoPath = `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  const repo = () => client.request<RepoJson>("GET", repoPath);

  const gitPush: ToolDef = {
    name: "git_push",
    description: `Push a branch from your working directory to ${cfg.owner}/${cfg.repo} on GitHub (never forced, never the default branch).`,
    schema: {
      type: "object",
      properties: { branch: { type: "string", description: "The local branch to push; the remote branch gets the same name." } },
      required: ["branch"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const branch = branchName(str(args, "branch"));
      if (!ctx.workdir) throw new Error("git_push needs a session with a working directory");
      const { default_branch, clone_url } = await repo();
      if (branch === default_branch) throw new Error(`Refusing to push to the default branch ${default_branch}`);

      const basic = Buffer.from(`x-access-token:${await client.installationToken()}`).toString("base64");
      client.addSecret(basic);
      const ref = `refs/heads/${branch}`;
      // The credential goes in through git's env config for this one process: not in argv (visible in
      // `ps`), not in the remote URL, not in any git config file. The empty credential helper stops a
      // rejected token from falling back to the host user's own GitHub credentials.
      const result = await runGit(["push", clone_url, `${ref}:${ref}`], {
        cwd: ctx.workdir,
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "http.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_1: "",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      if (result.code !== 0) {
        throw new Error(client.scrub(`git push exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`));
      }
      return { branch, pushed: true };
    },
  };

  const openPr: ToolDef = {
    name: "github_open_pr",
    description: `Open a pull request in ${cfg.owner}/${cfg.repo}, or return the one already open for the same head branch.`,
    idempotent: true,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "The pushed branch with your changes." },
        base: { type: "string", description: "The branch to merge into; defaults to the repository's default branch." },
      },
      required: ["title", "body", "head"],
      additionalProperties: false,
    },
    async execute(args) {
      const title = str(args, "title");
      const body = str(args, "body");
      const head = branchName(str(args, "head"));
      const base = optionalStr(args, "base");

      // Without the `owner:` prefix GitHub ignores the `head` filter, hence the prefix and the check on `ref`.
      const { items: open } = await client.paginate<PullJson>(
        `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${cfg.owner}:${head}`)}&per_page=100`,
      );
      const pr =
        open.find((p) => p.head.ref === head) ??
        (await client.request<PullJson>("POST", `${repoPath}/pulls`, {
          title,
          body,
          head,
          base: base ?? (await repo()).default_branch,
        }));
      // Also on the found PR: an earlier attempt may have created it and failed before labelling.
      await client.request("POST", `${repoPath}/issues/${pr.number}/labels`, { labels: [cfg.label] });
      return { number: pr.number, url: pr.html_url, thread: threadKey(cfg, pr.number) };
    },
  };

  const comment: ToolDef = {
    name: "github_comment",
    description: `Post a comment on an issue or pull request in ${cfg.owner}/${cfg.repo}.`,
    schema: {
      type: "object",
      properties: {
        thread: { type: "string", description: `The thread key, e.g. github:${cfg.owner}/${cfg.repo}#12.` },
        body: { type: "string" },
      },
      required: ["thread", "body"],
      additionalProperties: false,
    },
    async execute(args) {
      const number = threadNumber(cfg, str(args, "thread"));
      const body = str(args, "body");
      const c = await client.request<CommentJson>("POST", `${repoPath}/issues/${number}/comments`, { body });
      return { id: c.id, url: c.html_url };
    },
  };

  return [gitPush, openPr, comment];
}

function str(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string") throw new Error(`Argument ${key} must be a string`);
  return v;
}

function optionalStr(args: unknown, key: string): string | undefined {
  const v = (args as Record<string, unknown> | null)?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`Argument ${key} must be a string`);
  return v;
}

/**
 * A plain branch name. Rejects anything git could read as an option (`-f`), a forced or two-sided
 * refspec (`+x`, `a:b`), or a malformed ref.
 */
function branchName(raw: string): string {
  const name = raw.replace(/^refs\/heads\//, "");
  const ok =
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.split("/").some((part) => part.startsWith("."));
  if (!ok) throw new Error(`Not an acceptable branch name: ${JSON.stringify(raw)}`);
  return name;
}
