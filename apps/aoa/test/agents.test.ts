import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runGitWithBun } from "@aoa-dev/channel-github";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentInput } from "../src/config.ts";
import type { Snapshot } from "../src/observe.ts";
import { serve } from "../src/serve.ts";
import { type View, startWeb } from "../src/web.ts";
import { KEY_ENV, MODEL_KEY, World, call, lastResult, say, type Step } from "./world.ts";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** Yields to the event loop until `ok()` holds; real git and SQLite work in between, so no fixed delay fits. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const REVIEWER: Record<string, AgentInput> = { reviewer: { role: "review" } };

async function world(agents: Record<string, AgentInput> | null = REVIEWER): Promise<World> {
  const w = new World({ local: true, ...(agents ? { agents } : {}) });
  cleanup.push(() => w.dispose());
  return w.start();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGitWithBun(args, { cwd, env: {} });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const branchIn = (text: string) => /aoa\/(?:[a-z][a-z0-9-]*\/)?[0-9a-f]{8}/.exec(text)![0];

/** Edits and commits on the session's branch, then makes the call `then` builds from the branch, if any. */
function commit(then?: (branch: string) => AssistantMessage): Step[] {
  return [
    call("write", { path: "greeting.txt", content: "hello\n" }),
    call("bash", { command: "git add greeting.txt && git commit -qm 'Add greeting' && git branch --show-current" }),
    (m) => (then ? then(branchIn(lastResult(m))) : say("Done.")),
    ...(then ? [say("Done.")] : []),
  ];
}

const requestWith = (w: World, text: string) => {
  const found = w.modelRequests.find((r) => JSON.stringify(r.messages).includes(text));
  if (!found) throw new Error(`no model request mentions ${text}`);
  return JSON.stringify(found);
};

const payload = (e: { payload: unknown }) => e.payload as { from: string; text: string; branch?: string; hop: number; replyThread?: string };

describe("named agents", () => {
  test("the default agent keeps its inbox, memory, worktree and branch; a named implementer gets its own beside them", async () => {
    const w = await world({ ...REVIEWER, helper: {} });
    const data = w.config.dataDir;
    expect(w.agent.name).toBe("default");
    expect(w.agent.inboxId).toBe("local/repo");
    expect(w.agent.paths.memory).toBe(join(data, "memory", "local", "repo"));
    expect(w.named("reviewer").inboxId).toBe("local/repo@reviewer");

    w.script(commit());
    await w.cli("send", "Add a greeting file.");
    await w.drain();
    const [session] = w.sessions();
    expect(session!.workdir).toBe(join(data, "worktrees", "local", "repo", session!.id));
    expect(await w.repoGit("log", "-1", "--format=%s", `aoa/${session!.id.slice(0, 8)}`)).toBe("Add greeting");
    expect(requestWith(w, "Add a greeting file.")).toContain('"name":"send_to"');

    w.script(commit(), "helper");
    expect((await w.cli("send", "--agent", "helper", "Add it again.")).code).toBe(0);
    await w.drain("helper");
    const [helped] = w.sessions("helper");
    expect(helped!.workdir).toBe(join(data, "worktrees", "local", "repo@helper", helped!.id));
    expect(await w.repoGit("log", "-1", "--format=%s", `aoa/helper/${helped!.id.slice(0, 8)}`)).toBe("Add greeting");
  });

  test("a named agent's own model key leaves the environment its shell inherits", async () => {
    const env = { [KEY_ENV]: MODEL_KEY, AOA_REVIEWER_KEY: "sk-reviewer-secret" };
    const model = { provider: "scripted-reviewer", modelId: "agent", apiKeyEnv: "AOA_REVIEWER_KEY" };
    const w = new World({ local: true, env, agents: { reviewer: { role: "review", model } } });
    cleanup.push(() => w.dispose());
    await w.start();
    expect(w.env.AOA_REVIEWER_KEY).toBeUndefined();
    expect(w.env[KEY_ENV]).toBeUndefined();
  });

  test("with one agent there is no send_to", async () => {
    const w = await world(null);
    w.script([say("Nothing to do.")]);
    await w.cli("send", "Look around.");
    await w.drain();
    expect(requestWith(w, "Look around.")).not.toContain('"name":"send_to"');
  });

  test("send_to to an agent that does not exist is an error and appends nothing", async () => {
    const w = await world({ ...REVIEWER, helper: {} });
    let shown = "";
    w.script([
      call("send_to", { agent: "nobody", text: "Anyone there?" }),
      (m) => ((shown = lastResult(m)), say("Stopped.")),
    ]);
    await w.cli("send", "Try to reach someone.");
    await w.drain();
    expect(shown).toContain("No other agent is named nobody");
    expect(w.events("reviewer")).toHaveLength(0);
    expect(w.events("helper")).toHaveLength(0);
    expect(w.events().filter((e) => e.source === "agent_message")).toHaveLength(0);
  });

  test("send_to with a branch to an agent that does not review is an error and appends nothing", async () => {
    const w = await world({ ...REVIEWER, helper: {} });
    let shown = "";
    w.script([
      call("send_to", { agent: "helper", text: "Review this branch.", branch: "aoa/12345678" }),
      (m) => ((shown = lastResult(m)), say("Stopped.")),
    ]);
    await w.cli("send", "Hand a branch to the helper.");
    await w.drain();
    expect(shown).toContain("branch is only for a review agent");
    expect(shown).toContain("helper implements");
    expect(w.events("reviewer")).toHaveLength(0);
    expect(w.events("helper")).toHaveLength(0);
    expect(w.events().filter((e) => e.source === "agent_message")).toHaveLength(0);
  });

  test("send_to from an untainted task is trusted both ways; the reply resumes the implementer's original session", async () => {
    const w = await world();
    w.script(commit((branch) => call("send_to", { agent: "reviewer", text: "Adds greeting.txt; please review.", branch })));
    const thread = (await w.cli("send", "Add a greeting file.")).out.trim();
    await w.drain();
    const [implementing] = w.sessions();
    const branch = `aoa/${implementing!.id.slice(0, 8)}`;

    const [handoff] = w.events("reviewer");
    expect(handoff).toMatchObject({ source: "agent_message", trusted: true });
    expect(handoff!.thread).not.toBe(thread);
    expect(payload(handoff!)).toEqual({ from: "default", text: "Adds greeting.txt; please review.", branch, hop: 1, replyThread: thread });

    w.script([call("send_to", { agent: "default", text: "Looks good." }), say("Sent.")], "reviewer");
    await w.drain("reviewer");
    const [reviewing] = w.sessions("reviewer");
    expect(reviewing!.tainted).toBe(false);
    expect(requestWith(w, "please review")).toContain("trusted=true");

    const verdict = w.events().at(-1)!;
    expect(verdict).toMatchObject({ source: "agent_message", trusted: true, thread, resume: implementing!.id });
    expect(payload(verdict)).toMatchObject({ from: "reviewer", text: "Looks good.", hop: 2 });

    w.script([say("Noted.")]);
    await w.drain();
    expect(w.sessions()).toHaveLength(1);
    expect(w.runs().map((r) => r.sessionId)).toEqual([implementing!.id, implementing!.id]);
  });

  test("a tainted task's message is untrusted and taints the agent it reaches", async () => {
    const w = await world();
    w.script([say("Read it.")]);
    await w.cli("send", "Look at the issue someone filed.");
    await w.drain();
    const [implementing] = w.sessions();
    w.agent.store.tx((t) => t.markTainted(implementing!.id));

    w.script([call("send_to", { agent: "reviewer", text: "Please review." }), say("Sent.")]);
    await w.cli("send", "--to", implementing!.id, "Hand it to the reviewer.");
    await w.drain();
    expect(w.events("reviewer")[0]).toMatchObject({ source: "agent_message", trusted: false });

    w.script([say("Looked.")], "reviewer");
    await w.drain("reviewer");
    expect(w.sessions("reviewer")[0]!.tainted).toBe(true);
  });

  test("a trusted agent message on a task paused on an approval does not answer it", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script([call("send_to", { agent: "reviewer", text: "Please review." }), call("bash", { command: "echo deploy" }), say("Waiting.")]);
    await w.cli("send", "Ship it.");
    await w.drain();
    const { pending } = JSON.parse((await w.cli("status", "--json")).out);
    expect(pending).toHaveLength(1);

    w.script([call("send_to", { agent: "default", text: "/approve" }), say("Sent.")], "reviewer");
    await w.drain("reviewer");
    expect(w.events().at(-1)).toMatchObject({ source: "agent_message", trusted: true });
    await w.drain();
    expect(JSON.parse((await w.cli("status", "--json")).out).pending).toMatchObject([{ callId: pending[0].callId }]);
    expect(w.events().filter((e) => e.source === "approval_answer")).toHaveLength(0);
  });

  test("the fifth hop on one chain is refused and appends nothing, even from a later run of the session", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    const hop = (agent: string, text: string): Step[] => [call("send_to", { agent, text }), say("Sent.")];
    w.script(hop("reviewer", "one"));
    await w.cli("send", "Start a chain.");
    await w.drain();
    w.script(hop("default", "two"), "reviewer");
    await w.drain("reviewer");
    w.script(hop("reviewer", "three"));
    await w.drain();
    w.script(hop("default", "four"), "reviewer");
    await w.drain("reviewer");

    // An approval between the verdict and the next send: that run holds no agent message, and the count must not restart.
    let refused = "";
    w.script([
      call("bash", { command: "echo deploy" }),
      call("send_to", { agent: "reviewer", text: "five" }),
      (m) => ((refused = lastResult(m)), say("Stopping.")),
    ]);
    const before = w.events("reviewer").length;
    await w.drain();
    const { pending } = JSON.parse((await w.cli("status", "--json")).out);
    expect((await w.cli("answer", pending[0].callId, "approve")).code).toBe(0);
    await w.drain();
    expect(refused).toMatch(/notify/);
    expect(w.events("reviewer")).toHaveLength(before);
    expect(w.events("reviewer").map((e) => payload(e).hop)).toEqual([1, 3]);
    expect(w.events().filter((e) => e.source === "agent_message").map((e) => payload(e).hop)).toEqual([2, 4]);
  });

  test("a reviewer cannot edit or change history, can read it, and works detached at the branch's commit", async () => {
    const w = await world({ reviewer: { role: "review", instructions: "Also check the README." } });
    w.script(commit());
    await w.cli("send", "Add a greeting file.");
    await w.drain();
    const [implementing] = w.sessions();
    const branch = `aoa/${implementing!.id.slice(0, 8)}`;

    expect((await w.cli("send", "--agent", "reviewer", "--branch", "no-such-branch", "Review it.")).code).toBe(1);
    expect((await w.cli("send", "--branch", branch, "Review it.")).code).not.toBe(0);
    expect(w.events("reviewer")).toHaveLength(0);
    expect((await w.cli("send", "--agent", "reviewer", "--branch", branch, "Review this branch.")).code).toBe(0);

    const results: string[] = [];
    const next = (command: string): Step => (m) => (results.push(lastResult(m)), call("bash", { command }));
    w.script(
      [
        call("bash", { command: "git commit --allow-empty -qm sneaky" }),
        next("git -C . push origin HEAD"),
        next("git log --format=%s -1"),
        next("git merge-tree --write-tree main HEAD"),
        (m) => (results.push(lastResult(m)), say("Reviewed.")),
      ],
      "reviewer",
    );
    await w.drain("reviewer");
    const [commitResult, pushResult, logResult, mergeResult] = results;
    expect(commitResult).toContain("Blocked by policy");
    expect(pushResult).toContain("Blocked by policy");
    expect(logResult).toContain("Add greeting");
    expect(mergeResult).toMatch(/^[0-9a-f]{40}/);

    const request = requestWith(w, "Review this branch.");
    for (const tool of ["read", "bash", "send_to", "notify"]) expect(request).toContain(`"name":"${tool}"`);
    for (const tool of ["edit", "write", "ask_user"]) expect(request).not.toContain(`"name":"${tool}"`);
    expect(request).toContain("Also check the README.");

    const [reviewing] = w.sessions("reviewer");
    expect(await git(reviewing!.workdir!, "rev-parse", "HEAD")).toBe(await w.repoGit("rev-parse", branch));
    expect(await git(reviewing!.workdir!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(implementing!.workdir!, "branch", "--show-current")).toBe(branch);
  });

  test("serve runs two agents at once, and each inbox still has at most one run", async () => {
    const w = await world();
    const gate = Promise.withResolvers<void>();
    const started = { default: Promise.withResolvers<void>(), reviewer: Promise.withResolvers<void>() };
    const held = (agent: keyof typeof started): Step => async () => {
      started[agent].resolve();
      await gate.promise;
      return say("Done.");
    };
    w.script([held("default"), say("Second done.")]);
    w.script([held("reviewer")], "reviewer");
    let stop = () => {};
    const serving = serve(w.agent, new Promise<void>((resolve) => (stop = resolve)));
    await w.cli("send", "First task.");
    await w.cli("send", "Second task.");
    await w.cli("send", "--agent", "reviewer", "Review task.");
    // The nudge that wakes the workers for another process's sends, after the debounce.
    w.advance(5000);

    await Promise.all([started.default.promise, started.reviewer.promise]);
    const inFlight = (agent?: string) => w.runs(agent).filter((r) => r.endedAt === null).length;
    expect(inFlight()).toBe(1);
    expect(inFlight("reviewer")).toBe(1);
    expect(w.events().filter((e) => e.status === "pending")).toHaveLength(1);

    gate.resolve();
    await until(() => w.runs().filter((r) => r.endedAt !== null).length === 2 && w.runs("reviewer")[0]!.endedAt !== null, "all three runs");
    stop();
    await serving;
  });

  test("answer, messages, status, send --to and close reach every agent's inbox", async () => {
    const w = await world();
    w.judge = (shown) => (shown.includes("deploy") ? "unsure" : "allow");
    w.script([call("notify", { body: "Default says hi." }), say("Done.")]);
    await w.cli("send", "Say hi.");
    await w.drain();

    w.script(
      [call("bash", { command: "echo deployed >> deploy.log" }), call("notify", { body: "Reviewer done." }), say("Done.")],
      "reviewer",
    );
    const reviewThread = (await w.cli("send", "--agent", "reviewer", "Run the deploy check.")).out.trim();
    await w.drain("reviewer");
    expect((await w.named("reviewer").step.dispatcher()).delivered).toBe(1);
    expect(readFileSync(join(w.config.dataDir, "messages.md"), "utf8")).toContain(`reviewer · ${reviewThread} · approval_request`);
    expect(w.notes.at(-1)!.title).toContain("reviewer");

    type Listing = { messages: { id: string; agent: string; kind: string; body: string; callId: string | null }[]; cursor: string };
    const listing = JSON.parse((await w.cli("messages", "--json")).out) as Listing;
    expect(listing.messages.map((m) => [m.agent, m.kind])).toEqual([
      ["default", "message"],
      ["reviewer", "approval_request"],
    ]);
    const callId = listing.messages[1]!.callId!;
    expect((await w.cli("messages")).out).toContain("reviewer");

    w.script([call("notify", { body: "Default again." }), say("Done.")]);
    await w.cli("send", "Say it again.");
    await w.drain();

    const status = JSON.parse((await w.cli("status", "--json")).out);
    expect(status.pending).toMatchObject([{ callId, agent: "reviewer" }]);
    expect(status.sessions.map((s: { agent: string }) => s.agent)).toEqual(["default", "default", "reviewer"]);
    expect((await w.cli("status")).out).toContain("reviewer");

    expect((await w.cli("answer", callId.slice(0, 8), "approve")).code).toBe(0);
    expect(w.events("reviewer").at(-1)).toMatchObject({ source: "approval_answer" });
    await w.drain("reviewer");
    expect(readFileSync(join(w.sessions("reviewer")[0]!.workdir!, "deploy.log"), "utf8")).toBe("deployed\n");

    const later = JSON.parse((await w.cli("messages", "--json", "--since", listing.cursor)).out) as Listing;
    expect(later.messages.map((m) => [m.agent, m.body])).toEqual([
      ["default", "Default again."],
      ["reviewer", "Reviewer done."],
    ]);

    expect((await w.cli("send", "--to", reviewThread, "One more look.")).code).toBe(0);
    expect(w.events("reviewer").at(-1)).toMatchObject({ source: "user_message", thread: reviewThread });
    expect((await w.cli("close", reviewThread, "discarded")).code).toBe(0);
    expect(w.agent.records.results.get(w.sessions("reviewer")[0]!.id)?.result).toBe("discarded");
  });

  test("the page's snapshot carries each agent's state", async () => {
    const w = await world();
    w.script([call("send_to", { agent: "reviewer", text: "Please look." }), say("Sent.")]);
    await w.cli("send", "Hand something over.");
    await w.drain();
    await w.cli("send", "--agent", "reviewer", "And this.");
    const lock = w.agent.store.lock()!;
    lock.beat(w.clock.now());
    lock.release();

    let trigger = () => {};
    const server = startWeb(w.agent, {
      port: 0,
      watch: (onChange) => {
        trigger = onChange;
        return () => {};
      },
    });
    cleanup.push(() => server.stop());
    const view = (await (await fetch(`http://127.0.0.1:${server.port}/snapshot`)).json()) as View;
    expect(view.inboxId).toBe("local/repo");
    expect(view.agents.map((a) => [a.name, a.role])).toEqual([["reviewer", "review"]]);
    const reviewer: Snapshot = view.agents[0]!.snapshot;
    expect(reviewer.inboxId).toBe("local/repo@reviewer");
    expect(reviewer.memory.root).toBe(join(w.config.dataDir, "memory", "local", "repo@reviewer"));
    expect(reviewer.events.counts.pending).toBe(2);
    expect(reviewer.edges.in.total).toBe(2);
    expect(reviewer.inFromAgents.total).toBe(1);
    expect(view.inFromAgents.total).toBe(0);
    expect(reviewer.serve.state).toBe("running");

    const res = await fetch(`http://127.0.0.1:${server.port}/events`);
    const reader = res.body!.getReader();
    cleanup.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return JSON.parse(block.slice("data: ".length));
        }
        const { value } = await reader.read();
        buffer += decoder.decode(value, { stream: true });
      }
    };
    expect((await next()).snapshot.agents).toHaveLength(1);
    await w.cli("send", "--agent", "reviewer", "And that.");
    trigger();
    w.advance(50);
    const update = await next();
    expect(update.flows).toEqual({});
    expect(update.flowsByAgent).toEqual({ reviewer: { in: 1 } });
  });
});
