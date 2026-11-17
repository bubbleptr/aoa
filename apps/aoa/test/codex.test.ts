import { afterEach, expect, test } from "bun:test";
import { FakeAppServer, type FakeTurn } from "../../../packages/runtime-codex/test/fake-app-server.ts";
import { serve } from "../src/serve.ts";
import { type View, startWeb } from "../src/web.ts";
import { World } from "./world.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

/** A local world with a pi default agent and a codex agent `coder` whose app server is `fake`. */
async function world(fake: FakeAppServer): Promise<World> {
  const w = new World({ local: true, agents: { coder: { runtime: "codex" } } });
  w.spawnCodex = fake.spawn;
  cleanup.push(() => w.dispose());
  return w.start();
}

const askToRun = (t: FakeTurn, itemId: string) =>
  t.request("item/commandExecution/requestApproval", {
    threadId: t.threadId,
    turnId: t.turnId,
    itemId,
    kind: "command",
    command: "rm -rf build",
    cwd: "/work",
    reason: "clean before rebuilding",
  });

test("a codex agent's approval reaches the user; once approved, Codex is told to redo it and the same command is accepted unasked", async () => {
  const fake = new FakeAppServer([async (t) => void (await askToRun(t, "item-1")), async (t) => void (await askToRun(t, "item-7"))]);
  const w = await world(fake);

  await w.cli("send", "--agent", "coder", "Clean the build.");
  await w.drain("coder");
  const { pending } = JSON.parse((await w.cli("status", "--json")).out);
  expect(pending).toMatchObject([{ agent: "coder", tool: "codex_command", asks: expect.stringContaining("rm -rf build") }]);
  expect(fake.serverRequests[0]!.reply).toEqual({ decision: "decline" });
  expect(fake.sent("turn/interrupt")).toHaveLength(1);

  expect((await w.cli("answer", pending[0].callId, "approve")).code).toBe(0);
  await w.drain("coder");

  expect(fake.sent("thread/resume")).toMatchObject([{ threadId: "thread-1" }]);
  expect(fake.inputs[1]).toContain("approved");
  expect(fake.inputs[1]).toContain("rm -rf build");
  expect(fake.serverRequests[1]!.reply).toEqual({ decision: "accept" });
  const requests = w.agent.store.tx((t) => t.listOutbox(w.named("coder").inboxId)).filter((m) => m.kind === "approval_request");
  expect(requests).toHaveLength(1);
  expect(w.runs("coder").map((r) => r.end?.kind)).toEqual(["deferred", "silent"]);
  expect(w.sessions("coder")[0]).toMatchObject({ status: "open", runtimeRef: "thread-1" });
});

test("a codex agent works in its worktree and is offered aoa's tools, not aoa's coding tools", async () => {
  const fake = new FakeAppServer([
    async (t) =>
      void (await t.request("item/tool/call", {
        threadId: t.threadId,
        turnId: t.turnId,
        callId: "call-1",
        namespace: null,
        tool: "notify",
        arguments: { body: "Cleaned." },
      })),
  ]);
  const w = await world(fake);

  await w.cli("send", "--agent", "coder", "Clean the build.");
  await w.drain("coder");

  const [start] = fake.sent("thread/start");
  const offered = start.dynamicTools.map((t: { name: string }) => t.name);
  expect(offered).toContain("notify");
  expect(offered).toContain("memory_write");
  expect(offered).toContain("send_to");
  for (const coding of ["bash", "read", "write", "edit"]) expect(offered).not.toContain(coding);
  expect(fake.spawns).toEqual([w.sessions("coder")[0]!.workdir!]);
  expect(start.cwd).toBe(w.sessions("coder")[0]!.workdir);
  expect(w.agent.store.tx((t) => t.listOutbox(w.named("coder").inboxId))).toMatchObject([{ kind: "message", body: "Cleaned." }]);
  expect(w.runs("coder").map((r) => r.end?.kind)).toEqual(["sent"]);
});

test("status and the web snapshot say which runtime each agent runs on and who owns its permissions", async () => {
  const w = await world(new FakeAppServer());

  const status = JSON.parse((await w.cli("status", "--json")).out);
  expect(status.agents).toEqual([
    { name: "default", runtime: "pi", permissionOwner: "kernel", autoReview: false },
    { name: "coder", runtime: "codex", permissionOwner: "harness", autoReview: false },
  ]);
  const text = (await w.cli("status")).out;
  expect(text).toMatch(/default\s+pi\s+aoa decides/);
  expect(text).toMatch(/coder\s+codex\s+Codex decides/);

  const server = startWeb(w.agent, { port: 0, watch: () => () => {} });
  cleanup.push(() => server.stop());
  const view = (await (await fetch(`http://127.0.0.1:${server.port}/snapshot`)).json()) as View;
  expect([view.runtime, view.permissionOwner]).toEqual(["pi", "kernel"]);
  expect(view.permissions.waiting).toEqual([]);
  expect(view.agents.map((a) => [a.name, a.runtime, a.permissionOwner])).toEqual([["coder", "codex", "harness"]]);
});

test("serve says, once per codex agent, that Codex's own settings govern what it does unasked", async () => {
  const w = await world(new FakeAppServer());
  let stop = () => {};
  const done = serve(w.agent, new Promise<void>((resolve) => (stop = resolve)));
  stop();
  await done;

  const lines = w.logs.filter((l) => l.includes("Codex"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("coder");
  expect(lines[0]).toContain("~/.aoa");
});

test("a codex agent's model reaches Codex, and the default agent can run on Codex too", async () => {
  const fake = new FakeAppServer([
    async (t) =>
      void (await t.request("item/tool/call", {
        threadId: t.threadId,
        turnId: t.turnId,
        callId: "call-1",
        namespace: null,
        tool: "notify",
        arguments: { body: "Done." },
      })),
  ]);
  const w = new World({ local: true, codexDefault: true, classifier: false, env: {}, agents: { coder: { runtime: "codex", model: "gpt-test" } } });
  w.spawnCodex = fake.spawn;
  cleanup.push(() => w.dispose());
  await w.start();

  await w.cli("send", "Tidy up.");
  await w.drain();
  await w.cli("send", "--agent", "coder", "And this.");
  await w.drain("coder");

  const [first, second] = fake.sent("thread/start");
  expect(first).not.toHaveProperty("model");
  expect(second.model).toBe("gpt-test");
  expect(w.agent.store.tx((t) => t.listOutbox(w.agent.inboxId))).toMatchObject([{ kind: "message", body: "Done." }]);
  expect(JSON.parse((await w.cli("status", "--json")).out).agents[0]).toEqual({ name: "default", runtime: "codex", permissionOwner: "harness", autoReview: false });
});

test("a codex reviewer leaves its approvals to Codex's auto review, and status and serve say so", async () => {
  const fake = new FakeAppServer();
  const w = new World({ local: true, agents: { reviewer: { role: "review", runtime: "codex" } } });
  w.spawnCodex = fake.spawn;
  cleanup.push(() => w.dispose());
  await w.start();

  await w.cli("send", "--agent", "reviewer", "Review aoa/abc.");
  await w.drain("reviewer");
  expect(fake.sent("thread/start")[0]).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" });

  const status = JSON.parse((await w.cli("status", "--json")).out);
  expect(status.agents[1]).toEqual({ name: "reviewer", runtime: "codex", permissionOwner: "harness", autoReview: true });
  expect((await w.cli("status")).out).toMatch(/reviewer\s+codex\s+.*auto review/);

  let stop = () => {};
  const done = serve(w.agent, new Promise<void>((resolve) => (stop = resolve)));
  stop();
  await done;
  const line = w.logs.find((l) => l.includes("reviewer") && l.includes("Codex"));
  expect(line).toContain("auto review");
  expect(line).toContain("~/.aoa");
});
