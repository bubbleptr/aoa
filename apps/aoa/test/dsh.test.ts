import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeDshServer, type FakeTurn } from "../../../packages/runtime-dsh/test/fake-dsh-server.ts";
import { serve } from "../src/serve.ts";
import { type View, startWeb } from "../src/web.ts";
import { KEY_ENV, MODEL_KEY, World } from "./world.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

/** A local world with a pi default agent and a dsh agent `coder` whose harness is `fake`. */
async function world(fake: FakeDshServer): Promise<World> {
  const w = new World({ local: true, agents: { coder: { runtime: "dsh", model: "deepseek-flash", apiKeyEnv: KEY_ENV } } });
  w.spawnDsh = fake.spawn;
  cleanup.push(() => w.dispose());
  return w.start();
}

const askToRun = (t: FakeTurn, callId: string, args: object = { command: "rm -rf build", cwd: "/work" }) =>
  t.request("approval/request", { sessionId: t.sessionId, toolName: "bash", callId, reason: "clean before rebuilding" });

test("a dsh agent works in its worktree and says what its bridged tool did", async () => {
  const fake = new FakeDshServer([
    async (t) => {
      await t.toolCall("call-1", "mcp__aoa__notify", { body: "Cleaned." });
      await t.mcp("notify", { body: "Cleaned." });
    },
  ]);
  const w = await world(fake);

  await w.cli("send", "--agent", "coder", "Clean the build.");
  await w.drain("coder");

  expect(w.agent.store.tx((t) => t.listOutbox(w.named("coder").inboxId))).toMatchObject([{ kind: "message", body: "Cleaned." }]);
  expect(w.runs("coder").map((r) => r.end?.kind)).toEqual(["sent"]);
  expect(fake.launches[0]!.cwd).toBe(w.sessions("coder")[0]!.workdir!);
  expect(fake.launches[0]!.env.DSH_HOME).toBe(join(w.root, "data", "dsh-home"));
  expect(fake.launches[0]!.env.DEEPSEEK_API_KEY).toBe(MODEL_KEY);
});

test("a dsh agent is offered aoa's tools over the bridge, not aoa's coding tools", async () => {
  const fake = new FakeDshServer([
    async (t) => {
      const tools = await t.mcpTools();
      expect(tools).toContain("notify");
      expect(tools).toContain("memory_write");
      expect(tools).toContain("send_to");
      for (const coding of ["bash", "read", "write", "edit"]) expect(tools).not.toContain(coding);
    },
  ]);
  const w = await world(fake);

  await w.cli("send", "--agent", "coder", "Clean the build.");
  await w.drain("coder");
});

test("a dsh agent's approval reaches the user; once approved, dsh is told to redo it and the same call is allowed unasked", async () => {
  const fake = new FakeDshServer([async (t) => void (await askToRun(t, "call-1")), async (t) => void (await askToRun(t, "call-7"))]);
  const w = await world(fake);

  await w.cli("send", "--agent", "coder", "Clean the build.");
  await w.drain("coder");
  const { pending } = JSON.parse((await w.cli("status", "--json")).out);
  expect(pending).toMatchObject([{ agent: "coder", tool: "dsh:bash", asks: expect.stringContaining("rm -rf build") }]);
  expect(fake.serverRequests[0]!.reply).toEqual({ outcome: "rejected" });

  expect((await w.cli("answer", pending[0].callId, "approve")).code).toBe(0);
  await w.drain("coder");

  expect(fake.sent("session/resume")).toHaveLength(1);
  expect(fake.inputs[1]).toContain("approved");
  expect(fake.inputs[1]).toContain("rm -rf build");
  expect(fake.serverRequests[1]!.reply).toEqual({ outcome: "allowed-once" });
  const requests = w.agent.store.tx((t) => t.listOutbox(w.named("coder").inboxId)).filter((m) => m.kind === "approval_request");
  expect(requests).toHaveLength(1);
  expect(w.runs("coder").map((r) => r.end?.kind)).toEqual(["deferred", "silent"]);
  expect(w.sessions("coder")[0]).toMatchObject({ status: "open", runtimeRef: expect.any(String) });
});

test("status, the web snapshot and serve say a dsh agent runs on dsh with its own permissions", async () => {
  const w = await world(new FakeDshServer());

  const status = JSON.parse((await w.cli("status", "--json")).out);
  expect(status.agents).toEqual([
    { name: "default", runtime: "pi", permissionOwner: "kernel", autoReview: false },
    { name: "coder", runtime: "dsh", permissionOwner: "harness", autoReview: false },
  ]);
  expect((await w.cli("status")).out).toMatch(/default\s+pi\s+aoa decides/);
  expect((await w.cli("status")).out).toMatch(/coder\s+dsh\s+dsh decides/);

  const server = startWeb(w.agent, { port: 0, watch: () => () => {} });
  cleanup.push(() => server.stop());
  const view = (await (await fetch(`http://127.0.0.1:${server.port}/snapshot`)).json()) as View;
  expect(view.agents.map((a) => [a.name, a.runtime, a.permissionOwner])).toEqual([["coder", "dsh", "harness"]]);

  let stop = () => {};
  const done = serve(w.agent, new Promise<void>((resolve) => (stop = resolve)));
  stop();
  await done;
  const line = w.logs.find((l) => l.includes("coder") && l.includes("dsh"));
  expect(line).toContain("~/.aoa");
});

test("a dsh agent's model and key are the ones the harness is started with", async () => {
  const fake = new FakeDshServer();
  const w = await world(fake);

  await w.cli("send", "--agent", "coder", "Clean the build.");
  await w.drain("coder");

  expect(fake.sent("initialize")[0]).toMatchObject({ model: "deepseek-flash", provider: "deepseek-official" });
  expect(fake.launches[0]!.env.DEEPSEEK_API_KEY).toBe(MODEL_KEY);
});
