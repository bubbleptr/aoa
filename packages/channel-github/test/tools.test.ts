import { beforeEach, describe, expect, test } from "bun:test";
import type { ToolDef } from "@aoa/kernel";
import { type GitRunner, githubTools } from "../src/index.ts";
import { FakeGitHub, OWNER, REPO, USER, writeAppKey } from "./fake-github.ts";

const key = writeAppKey();
const ctx = { sessionId: "s1", callId: "c1", workdir: "/work/s1" };

type GitCall = { args: string[]; cwd: string; env: Record<string, string> };

let gh: FakeGitHub;
let gitCalls: GitCall[];
let tools: ToolDef[];

const tool = (name: string) => tools.find((t) => t.name === name)!;

beforeEach(() => {
  gh = new FakeGitHub(key.publicKeyPem);
  gitCalls = [];
  const runGit: GitRunner = async (args, opts) => {
    gitCalls.push({ args, ...opts });
    return { code: 0, stdout: "", stderr: "" };
  };
  tools = githubTools({ ...gh.config(key.path), runGit });
});

describe("git_push", () => {
  test("pushes exactly that branch, without force, with the token only in the environment", async () => {
    await tool("git_push").execute({ branch: "feat/login" }, ctx);

    expect(gitCalls).toHaveLength(1);
    const [call] = gitCalls;
    expect(call!.cwd).toBe("/work/s1");
    expect(call!.args).toEqual([
      "push",
      `https://github.test/${OWNER}/${REPO}.git`,
      "refs/heads/feat/login:refs/heads/feat/login",
    ]);
    for (const arg of call!.args) {
      expect(arg).not.toMatch(/^(-f|--force.*|--mirror|--delete|-d|\+.*)$/);
    }

    const token = gh.issuedTokens[0]!;
    expect(call!.args.join(" ")).not.toContain(token);
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    expect(call!.env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test("refuses the default branch however it is spelled", async () => {
    for (const branch of ["main", "refs/heads/main"]) {
      await expect(tool("git_push").execute({ branch }, ctx)).rejects.toThrow(/default branch/);
    }
    gh.defaultBranch = "trunk";
    await expect(tool("git_push").execute({ branch: "trunk" }, ctx)).rejects.toThrow(/default branch/);
    expect(gitCalls).toHaveLength(0);
  });

  test("refuses branch names that git would read as options or forced refspecs", async () => {
    for (const branch of ["-f", "--force", "+feat", "a:b", "feat x", "", "a..b"]) {
      await expect(tool("git_push").execute({ branch }, ctx)).rejects.toThrow();
    }
    expect(gitCalls).toHaveLength(0);
  });

  test("needs a working directory", async () => {
    await expect(tool("git_push").execute({ branch: "feat/x" }, { ...ctx, workdir: null })).rejects.toThrow();
    expect(gitCalls).toHaveLength(0);
  });
});

describe("github_open_pr", () => {
  test("opening twice with the same head yields one labelled PR", async () => {
    const args = { title: "Fix login", body: "Closes #1", head: "feat/login" };
    const first = await tool("github_open_pr").execute(args, ctx);
    const second = await tool("github_open_pr").execute(args, ctx);

    expect(second).toEqual(first);
    expect(gh.openPulls()).toHaveLength(1);
    const pr = gh.openPulls()[0]!;
    expect(first).toEqual({
      number: pr.number,
      url: `https://github.test/${OWNER}/${REPO}/pull/${pr.number}`,
      thread: `github:${OWNER}/${REPO}#${pr.number}`,
    });
    expect(pr.labels).toContain("aoa");
    expect(pr.pr?.base).toBe("main");
  });

  test("a PR created before a crash but never labelled gets its label on the retry", async () => {
    gh.fail({ status: 502, match: `POST /repos/${OWNER}/${REPO}/issues/1/labels` });
    const args = { title: "t", body: "b", head: "feat/x" };
    await expect(tool("github_open_pr").execute(args, ctx)).rejects.toThrow();
    await tool("github_open_pr").execute(args, ctx);
    expect(gh.openPulls()).toHaveLength(1);
    expect(gh.openPulls()[0]!.labels).toContain("aoa");
  });

  test("an open PR for another head is not mistaken for this one", async () => {
    await tool("github_open_pr").execute({ title: "a", body: "", head: "feat/a" }, ctx);
    await tool("github_open_pr").execute({ title: "b", body: "", head: "feat/b", base: "dev" }, ctx);
    expect(gh.openPulls().map((p) => [p.pr?.head, p.pr?.base])).toEqual([
      ["feat/a", "main"],
      ["feat/b", "dev"],
    ]);
  });

  test("declares itself safe to run again", () => {
    expect(tool("github_open_pr").idempotent).toBe(true);
  });
});

describe("github_comment", () => {
  test("comments on an issue in this repo", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    const out = (await tool("github_comment").execute(
      { thread: `github:${OWNER}/${REPO}#${n}`, body: "Done." },
      ctx,
    )) as { id: number; url: string };
    const [c] = gh.commentsOn(n);
    expect(out).toEqual({ id: c!.id, url: expect.stringContaining(`#issuecomment-${c!.id}`) });
    expect(c!.body).toBe("Done.");
  });

  test("refuses a thread in another repo", async () => {
    await expect(tool("github_comment").execute({ thread: "github:evil/repo#1", body: "x" }, ctx)).rejects.toThrow();
  });
});

describe("tool arguments", () => {
  test("missing or mistyped arguments are rejected before anything is sent", async () => {
    const before = gh.requests.length;
    await expect(tool("github_comment").execute({ thread: 1, body: "x" }, ctx)).rejects.toThrow(/thread/);
    await expect(tool("github_open_pr").execute({ title: "t", body: "b" }, ctx)).rejects.toThrow(/head/);
    await expect(tool("git_push").execute(null, ctx)).rejects.toThrow(/branch/);
    expect(gh.requests.length).toBe(before);
  });
});
