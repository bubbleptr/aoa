import { beforeEach, describe, expect, test } from "bun:test";
import { githubChannel, githubTools } from "../src/index.ts";
import { FakeGitHub, OWNER, REPO, USER, writeAppKey } from "./fake-github.ts";

const key = writeAppKey();
const HOUR = 60 * 60_000;
const ctx = { sessionId: "s1", callId: "c1", workdir: "/work/s1", signal: new AbortController().signal };

let gh: FakeGitHub;

beforeEach(() => {
  gh = new FakeGitHub(key.publicKeyPem);
});

describe("installation token", () => {
  test("is fetched once, reused, and refreshed after it expires", async () => {
    const channel = githubChannel(gh.config(key.path));
    const cursor = (await channel.poll(null)).cursor;
    await channel.poll(cursor);
    await channel.openThread("t", "b");
    expect(gh.tokenRequests).toBe(1);

    gh.advance(HOUR + 1000);
    await channel.poll(cursor);
    expect(gh.tokenRequests).toBe(2);
  });

  test("is refreshed before it runs out rather than used to the last second", async () => {
    const channel = githubChannel(gh.config(key.path));
    const cursor = (await channel.poll(null)).cursor;
    gh.advance(HOUR - 1000);
    await channel.poll(cursor);
    expect(gh.tokenRequests).toBe(2);
  });
});

describe("secrets never leak", () => {
  function expectClean(text: string | undefined) {
    for (const token of gh.issuedTokens) expect(text ?? "").not.toContain(token);
    expect(text ?? "").not.toContain("PRIVATE KEY");
  }

  async function caught(p: Promise<unknown>): Promise<Error> {
    try {
      await p;
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected a rejection");
  }

  test("an error echoing the Authorization header is scrubbed from poll, deliver and tools", async () => {
    const channel = githubChannel(gh.config(key.path));
    const tools = githubTools({
      ...gh.config(key.path),
      runGit: async () => {
        throw new Error("git must not run");
      },
    });
    const cursor = (await channel.poll(null)).cursor;
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    await tools.find((t) => t.name === "github_comment")!.execute({ thread: `github:${OWNER}/${REPO}#${n}`, body: "x" }, ctx);

    const errors: Error[] = [];
    gh.fail({ status: 500, echoAuth: true });
    errors.push(await caught(channel.poll(cursor)));
    gh.fail({ status: 500, echoAuth: true });
    errors.push(
      await caught(
        channel.deliver({
          id: "m",
          inboxId: "i",
          sessionId: "s",
          thread: `github:${OWNER}/${REPO}#${n}`,
          kind: "message",
          body: "b",
          callId: null,
          dedupeKey: "d",
          createdAt: gh.now,
          status: "sending",
          attempts: 0,
        }),
      ),
    );
    for (const tool of tools) {
      gh.fail({ status: 500, echoAuth: true });
      const args = {
        git_push: { branch: "feat/x" },
        github_open_pr: { title: "t", body: "b", head: "feat/x" },
        github_comment: { thread: `github:${OWNER}/${REPO}#${n}`, body: "x" },
      }[tool.name];
      errors.push(await caught(tool.execute(args, ctx)));
    }

    expect(errors).toHaveLength(5);
    for (const err of errors) {
      expect(err.message).toContain("500");
      expectClean(err.message);
      expectClean(err.stack);
      expectClean(String(err.cause ?? ""));
    }
  });

  test("git output echoing the credential is scrubbed", async () => {
    const tools = githubTools({
      ...gh.config(key.path),
      runGit: async (_args, opts) => ({
        code: 128,
        stdout: "",
        stderr: `fatal: unable to access: header ${Object.values(opts.env).join(" ")}`,
      }),
    });
    const push = tools.find((t) => t.name === "git_push")!;
    const err = await caught(push.execute({ branch: "feat/x" }, ctx));
    expect(err.message).toContain("fatal");
    expectClean(err.message);
    const basic = Buffer.from(`x-access-token:${gh.issuedTokens[0]}`).toString("base64");
    expect(err.message).not.toContain(basic);
  });
});
