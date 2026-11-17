import { expect, test } from "bun:test";
import { githubChannel, githubTools } from "../src/index.ts";
import { FakeGitHub, writeAppKey } from "./fake-github.ts";

const key = writeAppKey();
const ctx = { sessionId: "s1", callId: "c1", workdir: "/work/s1", signal: new AbortController().signal };

test("pullState tells an open, a merged and a closed pull request apart", async () => {
  const gh = new FakeGitHub(key.publicKeyPem);
  const channel = githubChannel(gh.config(key.path));
  const openPr = githubTools(gh.config(key.path)).find((t) => t.name === "github_open_pr")!;
  const open = async (head: string) =>
    ((await openPr.execute({ title: head, body: "", head }, ctx)) as { number: number }).number;
  const [a, b, c] = [await open("feat/a"), await open("feat/b"), await open("feat/c")];

  gh.closePull(b, true);
  gh.closePull(c);

  expect(await channel.pullState(a)).toBe("open");
  expect(await channel.pullState(b)).toBe("merged");
  expect(await channel.pullState(c)).toBe("closed");
});
