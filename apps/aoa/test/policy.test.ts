import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "@aoa/kernel";
import { agentPolicy } from "../src/policy.ts";

// Through tmpdir's symlink (/var -> /private/var on macOS), as a configured path may arrive.
const root = mkdtempSync(join(tmpdir(), "aoa-policy-"));
const workdir = join(root, "wt");
mkdirSync(join(workdir, "src"), { recursive: true });
symlinkSync(root, join(workdir, "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const policy = agentPolicy({});
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
    expect((await decide(policy, { tool: "bash", args: { command: "bun test" } }, ctx)).basis).toBe("classifier:missing");
    expect((await decide(policy, { tool: "deploy", args: {} }, ctx)).basis).toBe("risk:high");
    expect(await decision("github_open_pr", { title: "t", body: "b", head: "aoa/x" })).toBe("allow");
  });

  test("the config overrides a tool's tier", async () => {
    const strict = agentPolicy({ risk: { github_comment: "high" } });
    expect((await decide(strict, { tool: "github_comment", args: {} }, ctx)).decision).toBe("defer");
  });
});
