import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "@aoa/kernel";
import { agentPolicy, deferPush, reviewReadOnly, toolRisk } from "../src/policy.ts";

// Through tmpdir's symlink (/var -> /private/var on macOS), as a configured path may arrive.
const root = mkdtempSync(join(tmpdir(), "aoa-policy-"));
const workdir = join(root, "wt");
mkdirSync(join(workdir, "src"), { recursive: true });
symlinkSync(root, join(workdir, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Calls are decided by tool name here, so the tiers the tools carry come from the table.
const risk = toolRisk();
const policy = agentPolicy({ risk });
const ctx = { tainted: false, workdir: realpathSync(workdir) };
const decision = async (tool: string, args: object) => (await decide(policy, { tool, args }, ctx)).decision;

describe("file tools and the worktree", () => {
  test.each([
    ["read", { path: "src/a.ts" }],
    ["read", { path: join(workdir, "src/a.ts") }],
    ["write", { path: "new/dir/file.ts", content: "" }],
    ["ls", {}],
    ["grep", { pattern: "x", path: "src", glob: "**/*.ts" }],
    ["find", { pattern: "**/*.json" }],
  ])("%s inside the worktree is allowed: %j", async (tool, args) => {
    expect(await decision(tool, args)).toBe("allow");
  });

  test.each([
    ["read", { path: "/etc/hosts" }],
    ["read", { path: "../other/file" }],
    ["edit", { path: "src/../../x", edits: [] }],
    ["read", { path: "~/notes.txt" }],
    ["read", { path: "escape/wt2/file" }],
    ["ls", { path: ".." }],
    ["grep", { pattern: "x", glob: "../**" }],
    ["find", { pattern: "../../**/id_rsa" }],
  ])("%s outside the worktree is deferred: %j", async (tool, args) => {
    expect(await decide(policy, { tool, args }, ctx)).toEqual({ decision: "defer", basis: "rule:outside-worktree" });
  });

  test("a file tool in a session without a worktree is deferred", async () => {
    expect((await decide(policy, { tool: "read", args: { path: "a" } }, { tainted: false, workdir: null })).decision).toBe("defer");
  });
});

describe("risk tiers", () => {
  test("bash and git_push are medium, so without a classifier they wait; unknown tools are high", async () => {
    expect(await decision("bash", { command: "bun test" })).toBe("defer");
    expect((await decide(policy, { tool: "bash", args: { command: "bun test" } }, ctx)).basis).toBe("reviewer:missing");
    expect((await decide(policy, { tool: "deploy", args: {} }, ctx)).basis).toBe("risk:high");
    expect(await decision("github_open_pr", { title: "t", body: "b", head: "aoa/x" })).toBe("allow");
  });

  test("the config overrides a tool's tier", async () => {
    const strict = agentPolicy({ risk: { ...risk, github_comment: "high" } });
    expect((await decide(strict, { tool: "github_comment", args: {} }, ctx)).decision).toBe("defer");
  });
});

describe("local mode: no pushing without the user", () => {
  const local = agentPolicy({ risk, classify: async () => "allow", rules: [deferPush] });

  test.each(["git push", "git add -A && git commit -qm x && git push origin aoa/x", "git -C ../repo push", "echo ok; /usr/bin/git push -u origin HEAD"])(
    "%s is deferred even though the classifier would allow it",
    async (command) => {
      expect(await decide(local, { tool: "bash", args: { command } }, ctx)).toEqual({ decision: "defer", basis: "rule:local-push" });
    },
  );

  test("the kernel's blocks still come first: a force push is blocked, not offered for approval", async () => {
    expect(await decide(local, { tool: "bash", args: { command: "git push --force origin main" } }, ctx)).toEqual({
      decision: "block",
      basis: "rule:no-force-push",
    });
  });

  test("other git commands go to the classifier as before", async () => {
    expect(await decide(local, { tool: "bash", args: { command: "git commit -qm 'push the button'" } }, ctx)).toEqual({
      decision: "allow",
      basis: "reviewer:allow",
    });
  });
});

describe("a reviewer cannot change refs or history", () => {
  const review = agentPolicy({ risk, ahead: [reviewReadOnly], classify: async () => "allow" });

  test.each([
    ["merge", "git merge main"],
    ["rebase", "git rebase main"],
    ["reset", "git reset --hard HEAD"],
    ["cherry-pick", "git cherry-pick 1a2b3c4"],
    ["revert", "git revert HEAD"],
    ["tag", "git tag v1"],
    ["am", "git am < patch"],
    ["apply", "git apply patch.diff"],
    ["stash", "git stash"],
    ["checkout", "git checkout main"],
    ["switch", "git switch main"],
    ["worktree", "git worktree add ../elsewhere"],
    ["branch", "git branch -D aoa/x"],
  ])("git %s is blocked, not deferred or offered to the classifier", async (_sub, command) => {
    expect(await decide(review, { tool: "bash", args: { command } }, ctx)).toEqual({ decision: "block", basis: "rule:review-read-only" });
  });

  // The other half of the branch clause: listing branches is reading, not changing refs.
  test.each(["git branch --show-current", "git branch -vv"])("%s is still allowed", async (command) => {
    expect(await decide(review, { tool: "bash", args: { command } }, ctx)).toEqual({ decision: "allow", basis: "rule:read-only-commands" });
  });
});
