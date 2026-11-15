import { beforeEach, describe, expect, test } from "bun:test";
import type { OutMsg } from "@aoa/kernel";
import { githubChannel } from "../src/index.ts";
import { BOT, FakeGitHub, OWNER, REPO, USER, writeAppKey } from "./fake-github.ts";

const key = writeAppKey();

let gh: FakeGitHub;
let channel: ReturnType<typeof githubChannel>;

beforeEach(() => {
  gh = new FakeGitHub(key.publicKeyPem);
  channel = githubChannel(gh.config(key.path));
});

function msg(issue: number, over: Partial<OutMsg> = {}): OutMsg {
  return {
    id: "m1",
    inboxId: "i1",
    sessionId: "s1",
    thread: `github:${OWNER}/${REPO}#${issue}`,
    kind: "message",
    body: "Opened #9 for this.",
    callId: null,
    dedupeKey: "out:1",
    createdAt: gh.now,
    status: "sending",
    attempts: 0,
    ...over,
  };
}

describe("deliver", () => {
  test("posts the body as a comment on the thread", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    await channel.deliver(msg(n));
    const [c] = gh.commentsOn(n);
    expect(c?.author).toBe(BOT);
    expect(c?.body).toContain("Opened #9 for this.");
  });

  test("delivering the same message twice posts one comment", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    const m = msg(n);
    await channel.deliver(m);
    gh.advance(60_000);
    await channel.deliver(m);
    expect(gh.commentsOn(n)).toHaveLength(1);
  });

  test("a retry after a failed attempt posts exactly once", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    const m = msg(n);
    gh.fail({ status: 502, match: `POST /repos/${OWNER}/${REPO}/issues/${n}/comments` });
    await expect(channel.deliver(m)).rejects.toThrow();
    await channel.deliver(m);
    await channel.deliver(m);
    expect(gh.commentsOn(n)).toHaveLength(1);
  });

  test("someone else quoting the marker does not suppress delivery", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    gh.addComment(n, "stranger", "<!-- aoa:out:1 -->");
    await channel.deliver(msg(n));
    expect(gh.commentsOn(n).filter((c) => c.author === BOT)).toHaveLength(1);
  });

  test("distinct messages on one thread are all posted", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    await channel.deliver(msg(n, { dedupeKey: "out:1" }));
    await channel.deliver(msg(n, { dedupeKey: "out:2" }));
    expect(gh.commentsOn(n)).toHaveLength(2);
  });

  test("an approval request tells the user how to answer; a plain message does not", async () => {
    const n = gh.addIssue({ author: USER, labels: ["aoa"] });
    await channel.deliver(msg(n, { kind: "approval_request", callId: "c1", dedupeKey: "ask:c1", body: "Push?" }));
    await channel.deliver(msg(n, { dedupeKey: "out:2" }));
    const [ask, plain] = gh.commentsOn(n);
    expect(ask?.body).toContain("/approve");
    expect(ask?.body).toContain("/deny");
    expect(plain?.body).not.toContain("/approve");
  });

  test("a message without a thread, or for another repo, is refused", async () => {
    await expect(channel.deliver(msg(1, { thread: null }))).rejects.toThrow();
    await expect(channel.deliver(msg(1, { thread: "github:other/repo#1" }))).rejects.toThrow();
  });
});

describe("openThread", () => {
  test("creates a labelled issue as the App and returns its thread key", async () => {
    const t = await channel.openThread("Task from aoa send", "Do the thing");
    const n = Number(t.split("#")[1]);
    expect(t).toBe(`github:${OWNER}/${REPO}#${n}`);
    expect(gh.issue(n)).toMatchObject({ author: BOT, labels: ["aoa"], title: "Task from aoa send" });

    await channel.deliver(msg(n));
    expect(gh.commentsOn(n)).toHaveLength(1);
  });
});
