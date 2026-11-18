import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@aoa-dev/conformance";
import { createHost, type ToolDef } from "@aoa-dev/sdk";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { dshRuntime } from "../src/index.ts";
import { FakeDshServer, type FakeTurn, type TurnScript } from "./fake-dsh-server.ts";

let home: string;
const opened: { close(): void }[] = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "aoa-dsh-kernel-")));
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  rmSync(home, { recursive: true, force: true });
});

const pingCount = { executions: 0 };
const ping: ToolDef = {
  name: "ping",
  risk: "low",
  description: "Counts how often it really ran.",
  schema: { type: "object", properties: {} },
  async execute() {
    pingCount.executions++;
    return "pong";
  },
};

/** The dsh runtime as an SDK user hosts it, driven one pass at a time. */
function hosted(scripts: TurnScript[]) {
  pingCount.executions = 0;
  const fake = new FakeDshServer(scripts);
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const agent = host.agent({
    name: "dsh",
    inbox: "inbox",
    debounceMs: 0,
    runtime: dshRuntime({
      systemPrompt: "",
      model: "deepseek-flash",
      apiKey: "sk-test",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      home,
      cwd: "/repo",
      spawn: fake.spawn,
      log: () => {},
    }),
    tools: [ping],
  });
  let n = 0;
  const say = () => agent.append({ source: "user_message", dedupeKey: `m${++n}`, payload: { text: `message ${n}` }, thread: "local:1", trusted: true });
  return { fake, host, agent, clock, say };
}

const askToRun = (t: FakeTurn, callId: string, args: object = { command: "rm -rf build" }) =>
  t.request("approval/request", { sessionId: t.sessionId, toolName: "bash", callId });

test("a deferred approval leaves one request in the outbox and pauses the session on dsh's call", async () => {
  const { fake, host, agent, say } = hosted([
    async (t) => {
      await t.toolCall("call-1", "bash", { command: "rm -rf build" });
      await askToRun(t, "call-1");
    },
  ]);
  say();
  await agent.step.worker();

  const [run] = agent.read.runs();
  const callId = `${run!.sessionId}:call-1`;
  expect(run!.end).toEqual({ kind: "deferred", callId });
  expect(host.messages().filter((m) => m.kind === "approval_request")).toMatchObject([{ callId, body: expect.stringContaining("rm -rf build") }]);
  expect(fake.serverRequests[0]!.reply).toEqual({ outcome: "rejected" });
  expect(agent.read.sessions()[0]).toMatchObject({ status: "paused", pending: callId, runtimeRef: expect.any(String) });
});

test("approve: the resumed run says so, dsh asks again with the same arguments and is allowed without a second request", async () => {
  const { fake, host, agent, say } = hosted([
    async (t) => {
      await t.toolCall("call-1", "bash", { command: "rm -rf build", cwd: "/work" });
      await askToRun(t, "call-1", { command: "rm -rf build", cwd: "/work" });
    },
    async (t) => {
      await t.toolCall("call-2", "bash", { command: "rm -rf build", cwd: "/work" });
      await askToRun(t, "call-2", { command: "rm -rf build", cwd: "/work" });
    },
  ]);
  say();
  await agent.step.worker();
  const [run] = agent.read.runs();
  const callId = `${run!.sessionId}:call-1`;
  agent.answer(callId, { verdict: "approve" });
  await agent.step.worker();

  expect(fake.inputs[1]).toContain("approved");
  expect(fake.inputs[1]).toContain("rm -rf build");
  expect(fake.serverRequests.map((r) => r.reply)).toEqual([{ outcome: "rejected" }, { outcome: "allowed-once" }]);
  expect(host.messages().filter((m) => m.kind === "approval_request")).toHaveLength(1);
  expect(agent.read.runs().map((r) => [r.error, r.end?.kind])).toEqual([
    [null, "deferred"],
    [null, "silent"],
  ]);
});

test("notify through the MCP bridge is decided, journaled and lands in the outbox; the result reaches dsh", async () => {
  const { fake, host, agent, say } = hosted([
    async (t) => {
      await t.toolCall("call-1", "mcp__aoa__notify", { body: "Branch aoa/1 is ready." });
      const reply = await t.mcp("notify", { body: "Branch aoa/1 is ready." });
      expect(reply.isError).toBe(false);
      expect(reply.text).toContain("msgId");
    },
  ]);
  say();
  await agent.step.worker();

  const [run] = agent.read.runs();
  const callId = `${run!.sessionId}:call-1`;
  expect(agent.read.decisions(run!.sessionId).map((d) => [d.callId, d.tool, d.decision])).toEqual([[callId, "notify", "allow"]]);
  expect(agent.read.journal(run!.sessionId)).toMatchObject([{ callId, state: "done", result: { status: "ok" } }]);
  expect(host.messages()).toMatchObject([{ kind: "message", body: "Branch aoa/1 is ready." }]);
  expect(run!.end).toMatchObject({ kind: "sent" });
  expect(fake.live).toBe(0);
});

test("a retried run replays the journaled MCP call under the same call id instead of running it again", async () => {
  const call: TurnScript = async (t) => {
    await t.toolCall("call-1", "mcp__aoa__ping", {});
    const reply = await t.mcp("ping", {});
    expect(reply.text).toBe("pong");
  };
  const { fake, agent, clock, say } = hosted([
    async (t) => {
      await call(t);
      t.die("dsh exited with code 137");
    },
    call,
  ]);
  say();
  await agent.step.worker();
  // Past the retry delay after one failure.
  clock.advance(60 * 60_000);
  await agent.step.worker();

  expect(agent.read.runs().map((r) => r.error !== null)).toEqual([true, false]);
  // The retry makes the call under the same kernel id; the journal answers it, so the tool ran once.
  expect(pingCount.executions).toBe(1);
  expect(fake.inputs[1]).toContain("interrupted");
});

test("ask_user through the MCP bridge pauses the session and stops dsh", async () => {
  const { fake, host, agent, say } = hosted([
    async (t) => {
      await t.toolCall("call-1", "mcp__aoa__ask_user", { question: "Which colour?" });
      await t.mcp("ask_user", { question: "Which colour?" });
    },
  ]);
  say();
  await agent.step.worker();

  const [run] = agent.read.runs();
  expect(run!.end).toEqual({ kind: "deferred", callId: `${run!.sessionId}:call-1` });
  expect(host.messages()).toMatchObject([{ kind: "approval_request", body: "Which colour?" }]);
  expect(fake.sent("shutdown")).toHaveLength(1);
});
