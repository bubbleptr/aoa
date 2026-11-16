import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { World, call, lastResult, say, type Step } from "./world.ts";

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.dispose();
  worlds = [];
});

async function world(): Promise<World> {
  const w = new World({ local: true });
  worlds.push(w);
  return w.start();
}

const branchIn = (text: string) => /aoa\/[0-9a-f]{8}/.exec(text)![0];

/** The flow the local system prompt asks for: edit, commit on the current branch, tell the user the branch. */
function happyScript(): Step[] {
  return [
    call("write", { path: "greeting.txt", content: "hello\n" }),
    call("bash", { command: "git add greeting.txt && git commit -qm 'Add greeting' && git branch --show-current" }),
    (m) => call("notify", { body: `Committed on ${branchIn(lastResult(m))}: adds greeting.txt.` }),
    say("Done."),
  ];
}

const messagesFile = (w: World) => join(w.agent.paths.dataDir, "messages.md");
const messages = (w: World) => readFileSync(messagesFile(w), "utf8");
const markers = (text: string) => text.match(/<!-- aoa:/g)?.length ?? 0;

/** `aoa send`, one run, and its message delivered 3 seconds after the run. */
async function happyPath(w: World) {
  w.script(happyScript());
  const sent = await w.cli("send", "Add a greeting file.");
  expect(sent.code).toBe(0);
  const thread = sent.out.trim();
  expect((await w.drain()).runs).toBe(1);
  w.advance(3000);
  expect((await w.dispatch()).delivered).toBe(1);
  return { thread, session: w.sessions()[0]! };
}

async function status(w: World) {
  const r = await w.cli("status", "--json");
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
}

describe("local mode", () => {
  test("send runs the task in a fresh worktree; the commit stays on a local branch; one entry and one notification", async () => {
    const w = await world();
    expect(await w.repoGit("remote")).toBe("");
    const { thread, session } = await happyPath(w);

    expect(thread).toMatch(/^local:[0-9a-f]{8}$/);
    expect(w.pendingSteps()).toBe(0);
    expect(w.runs().map((r) => r.end?.kind)).toEqual(["sent"]);
    expect(w.agent.inboxId).toBe("local/repo");
    expect(session.workdir).toBe(join(w.config.dataDir, "worktrees", "local", "repo", session.id));
    const branch = `aoa/${session.id.slice(0, 8)}`;
    expect(await w.repoGit("log", "-1", "--format=%s", branch)).toBe("Add greeting");

    // The model was never offered a way to push, open a pull request or follow one.
    // The model was never offered a way to push, open a pull request or follow one, nor told to.
    const first = JSON.stringify(w.modelRequests[0]);
    expect(first).toContain('"name":"notify"');
    for (const tool of ["git_push", "github_open_pr", "github_comment", "follow"]) expect(first).not.toContain(`"name":"${tool}"`);
    expect(first).not.toContain("Push the branch");

    const text = messages(w);
    expect(markers(text)).toBe(1);
    expect(text).toContain(`Committed on ${branch}`);
    expect(text).toContain(thread);
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.body).toContain(branch);

    // Delivering the same message again, as after a crash mid-delivery, adds nothing and notifies nobody.
    const [sent] = w.agent.store.tx((t) => t.listOutbox(w.agent.inboxId));
    await w.agent.channel.deliver(sent!);
    expect(messages(w)).toBe(text);
    expect(w.notes).toHaveLength(1);

    const report = await status(w);
    expect(report.sessions).toEqual([
      {
        session: session.id,
        thread,
        state: "open",
        outcome: "in progress",
        asked: 0,
        branch,
        timeToMessageMs: 5000,
      },
    ]);
    const table = (await w.cli("status")).out;
    expect(table).toMatch(/BRANCH\s+TIME TO MESSAGE/);
    expect(table).toMatch(new RegExp(`${session.id.slice(0, 8)}\\s+${thread}\\s+open\\s+in progress\\s+0\\s+${branch}\\s+5s`));
    expect(table).not.toContain("PR");
  });

  test("a deferred call writes one approval entry naming aoa answer; answering runs the call exactly once", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script([call("bash", { command: "echo deployed >> deploy.log" }), say("Deployed."), say("Nothing left.")]);
    await w.cli("send", "Deploy it.");
    await w.drain();
    expect(w.runs().map((r) => r.end?.kind)).toEqual(["deferred"]);
    const workdir = w.sessions()[0]!.workdir!;
    await w.dispatch();

    const { pending } = await status(w);
    expect(pending).toHaveLength(1);
    const { callId } = pending[0];
    const text = messages(w);
    expect(markers(text)).toBe(1);
    expect(text).toContain(`aoa answer ${callId} approve`);
    expect(text).toContain(`aoa answer ${callId} deny <reason>`);
    expect(w.notes).toHaveLength(1);

    expect((await w.cli("answer", callId.slice(0, 8), "approve")).code).toBe(0);
    await w.drain();
    expect(readFileSync(join(workdir, "deploy.log"), "utf8")).toBe("deployed\n");

    expect((await w.cli("answer", callId, "approve")).code).toBe(1);
    w.script([say("Nothing left.")]);
    await w.cli("send", "--to", w.sessions()[0]!.id.slice(0, 8), "Anything else?");
    await w.drain();
    expect(readFileSync(join(workdir, "deploy.log"), "utf8")).toBe("deployed\n");
  });

  test("send --to lands on the same session; an unknown target lists the tasks", async () => {
    const w = await world();
    const { thread, session } = await happyPath(w);

    w.script([say("Will do.")]);
    const sent = await w.cli("send", "--to", thread.slice(0, 10), "Use a capital H.");
    expect(sent).toMatchObject({ code: 0, out: `${thread}\n` });
    expect(w.events().at(-1)).toMatchObject({ source: "user_message", trusted: true, thread, resume: session.id });
    await w.drain();
    expect(w.runs().map((r) => r.sessionId)).toEqual([session.id, session.id]);
    expect(JSON.stringify(w.modelRequests.at(-1))).toContain("Use a capital H.");

    const unknown = await w.cli("send", "--to", "local:zz", "Hello?");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('No task matches "local:zz"');
    expect(unknown.err).toContain(thread);
    expect(w.events()).toHaveLength(2);
  });

  test("on a session waiting for an answer, send --to text is the answer: plain text denies with it as the reason", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script([call("bash", { command: "echo deployed >> deploy.log" }), say("Understood, not deploying.")]);
    const thread = (await w.cli("send", "Deploy it.")).out.trim();
    await w.drain();
    const session = w.sessions()[0]!;
    expect(session.status).toBe("paused");

    expect((await w.cli("send", "--to", thread, "Not today, the release is frozen.")).code).toBe(0);
    expect(w.events().at(-1)).toMatchObject({
      source: "approval_answer",
      resume: session.id,
      payload: { callId: session.pending, verdict: "deny", text: "Not today, the release is frozen." },
    });
    await w.drain();
    expect(existsSync(join(session.workdir!, "deploy.log"))).toBe(false);
    expect(w.sessions()[0]).toMatchObject({ status: "open", pending: null });
    expect(JSON.stringify(w.modelRequests.at(-1))).toContain("the release is frozen");
  });

  test("on a session waiting for an answer, send --to /approve runs the call", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script([call("bash", { command: "echo deployed >> deploy.log" }), say("Deployed.")]);
    const thread = (await w.cli("send", "Deploy it.")).out.trim();
    await w.drain();
    const workdir = w.sessions()[0]!.workdir!;

    await w.cli("send", "--to", thread, "/approve");
    await w.drain();
    expect(readFileSync(join(workdir, "deploy.log"), "utf8")).toBe("deployed\n");
  });

  test("close only records; the finish check then closes the session and removes the worktree, keeping the branch", async () => {
    const w = await world();
    const { thread, session } = await happyPath(w);
    const branch = `aoa/${session.id.slice(0, 8)}`;

    const closed = await w.cli("close", thread, "merged");
    expect(closed.code).toBe(0);
    expect(w.sessions()[0]).toMatchObject({ status: "open", workdir: session.workdir });
    expect(existsSync(session.workdir!)).toBe(true);
    expect((await status(w)).sessions[0]).toMatchObject({ outcome: "merged" });

    await w.agent.closeFinished();
    expect(w.sessions()[0]).toMatchObject({ status: "closed", workdir: null });
    expect(existsSync(session.workdir!)).toBe(false);
    expect(await w.repoGit("log", "-1", "--format=%s", branch)).toBe("Add greeting");
    expect((await status(w)).sessions[0]).toMatchObject({ state: "closed", outcome: "merged" });

    // The declaration closes the session once: sending to it again reopens it on its branch, and it stays open.
    w.script([call("bash", { command: "git branch --show-current && cat greeting.txt" }), say("Back on it.")]);
    await w.cli("send", "--to", thread, "One more change.");
    await w.drain();
    await w.agent.closeFinished();
    expect(w.sessions()[0]).toMatchObject({ status: "open", workdir: session.workdir });
    expect(JSON.stringify(w.modelRequests.at(-1))).toContain(`${branch}\\nhello`);
  });

  test("a user message after the first delivered message makes a merged task reworked", async () => {
    const w = await world();
    const { thread } = await happyPath(w);
    w.script([say("Will do.")]);
    w.advance(1000);
    await w.cli("send", "--to", thread, "Use a capital H.");
    await w.drain();

    await w.cli("close", thread, "merged");
    await w.agent.closeFinished();
    expect((await status(w)).sessions[0]).toMatchObject({ state: "closed", outcome: "reworked" });
  });

  test("close discarded ends the task as discarded", async () => {
    const w = await world();
    const { session } = await happyPath(w);
    expect((await w.cli("close", session.id.slice(0, 8), "discarded")).code).toBe(0);
    await w.agent.closeFinished();
    expect((await status(w)).sessions[0]).toMatchObject({ state: "closed", outcome: "discarded" });
    expect((await w.cli("close", session.id, "shipped")).code).toBe(1);
  });

  test("a bash call that pushes is deferred to the user even though the classifier allows everything", async () => {
    const w = await world();
    w.script([call("bash", { command: "git commit --allow-empty -qm x && git push origin HEAD" }), say("unreachable")]);
    await w.cli("send", "Push it.");
    await w.drain();

    const [session] = w.sessions();
    expect(session).toMatchObject({ status: "paused" });
    const decisions = w.agent.store.tx((t) => t.listDecisions(session!.id));
    expect(decisions.map((d) => [d.tool, d.decision, d.basis])).toEqual([["bash", "defer", "rule:local-push"]]);
  });
});

test("in GitHub mode, close is refused: the pull request decides", async () => {
  const w = new World();
  worlds.push(w);
  await w.start();
  const r = await w.cli("close", "github:acme/widgets#1", "merged");
  expect(r.code).toBe(1);
  expect(r.err).toContain("pull request decides");
});
