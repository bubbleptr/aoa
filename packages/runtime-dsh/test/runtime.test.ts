import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, PermissionAsk, RunInput, Tool, ToolResult } from "@aoa/kernel";
import { DISABLED_ROWS, SHUTDOWN_GRACE_MS, dshRuntime, type DshRuntimeConfig } from "../src/index.ts";
import { FakeDshServer, dyingDsh, type FakeTurn } from "./fake-dsh-server.ts";

const INSTRUCTIONS = "You are a test agent.";
const KEY = "sk-dsh-secret-7c31a";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(fake: FakeDshServer, over: Partial<DshRuntimeConfig> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "aoa-dsh-home-")));
  homes.push(home);
  const runtime = dshRuntime({
    systemPrompt: INSTRUCTIONS,
    model: "deepseek-flash",
    apiKey: KEY,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    home,
    cwd: "/repo",
    spawn: fake.spawn,
    log: () => {},
    ...over,
  });
  return { runtime, home };
}

function event(text: string): Event {
  return {
    id: "evt-1",
    inboxId: "inbox",
    source: "user_message",
    dedupeKey: "d-1",
    receivedAt: 0,
    payload: { text },
    thread: null,
    resume: null,
    trusted: true,
    status: "in_run",
    leaseUntil: null,
    attempts: 0,
    nextAttemptAt: 0,
    run: null,
  };
}

function runInput(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: "run-1",
    session: { id: "session-1", resumed: false, ref: null, workdir: "/work/tree" },
    events: [event("fix the widget")],
    resident: "",
    tools: [],
    ask: async () => "allow",
    ...over,
  };
}

function recordingTool(name: string, respond: (args: unknown) => ToolResult) {
  const calls: { callId: string; args: unknown }[] = [];
  const tool: Tool = {
    name,
    description: `Test tool ${name}.`,
    schema: { type: "object", properties: { body: { type: "string" } } },
    async invoke(callId, args) {
      calls.push({ callId, args });
      return respond(args);
    },
  };
  return { tool, calls };
}

function recordingAsk(verdict: (a: PermissionAsk) => "allow" | "defer") {
  const asks: PermissionAsk[] = [];
  return { asks, ask: async (a: PermissionAsk) => (asks.push(a), verdict(a)) };
}

const askToRun = (t: FakeTurn, callId: string, tool = "bash", args: object = { command: "rm -rf build" }, reason = "clean before rebuilding") =>
  t.request("approval/request", { sessionId: t.sessionId, toolName: tool, callId, reason });

describe("dshRuntime: sessions", () => {
  test("a new session initializes with approvals and questions enabled, then prompts a session id aoa made and keeps it as the ref", async () => {
    const fake = new FakeDshServer();
    const { runtime, home } = setup(fake);

    const result = await runtime.run(runInput());

    expect(fake.versionChecks).toEqual(["dsh"]);
    const [launch] = fake.launches;
    expect(launch!.cwd).toBe("/work/tree");
    expect(launch!.command).toBe("dsh");
    expect(launch!.args.slice(0, 2)).toEqual(["--profile", "sdk"]);
    expect(launch!.env.DSH_HOME).toBe(home);
    expect(launch!.env.DEEPSEEK_API_KEY).toBe(KEY);
    expect(launch!.env.AOA_DSH_SYSTEM_PROMPT).toBe(INSTRUCTIONS);
    expect(fake.sent("initialize")).toEqual([
      {
        cwd: "/work/tree",
        approvalRequests: true,
        provider: "deepseek-official",
        model: "deepseek-flash",
        capabilities: { userQuestions: true },
      },
    ]);
    const [prompt] = fake.sent("session/prompt");
    expect(prompt.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prompt.contentBlocks[0]).toEqual({ type: "text", text: expect.stringContaining("fix the widget") });
    expect(result).toEqual({ end: { kind: "silent" }, sessionRef: prompt.sessionId });
    // The run waits for dsh to report idle, and shuts it down rather than leaving it running.
    expect(fake.sent("shutdown")).toHaveLength(1);
    expect(fake.live).toBe(0);
  });

  test("a resumed session resumes its id first, then prompts it, and the ref does not change", async () => {
    const fake = new FakeDshServer();
    const { runtime } = setup(fake, { model: "deepseek-pro" });

    const result = await runtime.run(runInput({ session: { id: "session-1", resumed: true, ref: "sess-77", workdir: null } }));

    expect(fake.launches[0]!.cwd).toBe("/repo");
    expect(fake.received.map((m) => m.method)).toEqual(["initialize", "session/resume", "session/prompt", "shutdown"]);
    expect(fake.sent("session/resume")).toEqual([{ sessionId: "sess-77" }]);
    expect(fake.sent("session/prompt")[0].sessionId).toBe("sess-77");
    expect(fake.sent("initialize")[0].model).toBe("deepseek-pro");
    expect(result.sessionRef).toBe("sess-77");
  });

  test("the child environment carries what dsh needs and the key, not the rest of aoa's environment", async () => {
    const fake = new FakeDshServer();
    const { runtime } = setup(fake, {
      env: { PATH: "/usr/bin", HOME: "/home/x", TMPDIR: "/tmp", DEEPSEEK_API_KEY: "sk-parent", OTHER_AGENT_KEY: "sk-other", LEAK: "x" },
    });

    await runtime.run(runInput());

    expect(Object.keys(fake.launches[0]!.env).sort()).toEqual(["AOA_DSH_SYSTEM_PROMPT", "DEEPSEEK_API_KEY", "DSH_HOME", "HOME", "PATH", "TMPDIR"]);
    expect(fake.launches[0]!.env.DEEPSEEK_API_KEY).toBe(KEY);
  });

  test("a dsh that is not the version aoa was tested with fails the run before anything is started", async () => {
    const fake = new FakeDshServer();
    fake.version = "0.2.2-rc.1";
    const { runtime } = setup(fake);

    await expect(runtime.run(runInput())).rejects.toThrow(/dsh 0\.2\.2-rc\.3.*0\.2\.2-rc\.1/);
    expect(fake.launches).toHaveLength(0);
  });

  test("a missing key and a dsh that cannot start both fail the run with what is wrong", async () => {
    const { runtime } = setup(new FakeDshServer(), { apiKey: undefined, apiKeyEnv: "MY_DSH_KEY" });
    await expect(runtime.run(runInput())).rejects.toThrow(/MY_DSH_KEY is not set/);

    const dying = setup(new FakeDshServer(), { spawn: dyingDsh }).runtime;
    await expect(dying.run(runInput())).rejects.toThrow(/cannot find package/);
  });
});

describe("dshRuntime: approval requests from dsh's own tools", () => {
  test("a call dsh logged is asked about with dsh's tool name and the logged arguments; allow permits it once", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-1", "bash", { command: "rm -rf build", cwd: "/work/tree" });
        await askToRun(t, "call-1");
      },
    ]);
    const gate = recordingAsk(() => "allow");
    const { runtime } = setup(fake);

    const result = await runtime.run(runInput({ ask: gate.ask }));

    expect(gate.asks).toEqual([
      {
        callId: "session-1:call-1",
        tool: "dsh:bash",
        args: { command: "rm -rf build", cwd: "/work/tree" },
        reason: "clean before rebuilding",
      },
    ]);
    expect(fake.serverRequests[0]!.reply).toEqual({ outcome: "allowed-once" });
    expect(result.end).toEqual({ kind: "silent" });
  });

  test("a sub-call made from run_code is asked about under its sub-call id and arguments", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.ptcCall("sub-1", "bash", { command: "ls -la" });
        await askToRun(t, "sub-1");
      },
    ]);
    const gate = recordingAsk(() => "allow");
    const { runtime } = setup(fake);

    await runtime.run(runInput({ ask: gate.ask }));

    expect(gate.asks).toMatchObject([{ callId: "session-1:sub-1", tool: "dsh:bash", args: { command: "ls -la" } }]);
  });

  test("defer: dsh is told rejected, asked nothing more, shut down, and the run ends deferred", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-1", "bash", { command: "rm -rf build" });
        await t.toolCall("call-2", "bash", { command: "ls" });
        // Both asks go out before either answer: dsh may ask again while the shutdown is on its way, and that
        // second request is refused without asking the kernel.
        await Promise.all([askToRun(t, "call-1"), askToRun(t, "call-2")]);
      },
    ]);
    fake.stayAfterShutdown = true;
    const gate = recordingAsk(() => "defer");
    const { runtime } = setup(fake);

    const result = await runtime.run(runInput({ ask: gate.ask }));

    expect(fake.serverRequests.map((r) => r.reply)).toEqual([{ outcome: "rejected" }, { outcome: "rejected" }]);
    expect(gate.asks).toHaveLength(1);
    expect(fake.sent("shutdown")).toHaveLength(1);
    expect(result).toEqual({ end: { kind: "deferred", callId: "session-1:call-1" }, sessionRef: expect.any(String) });
    expect(fake.live).toBe(0);
  });

  test("a dsh that does not answer shutdown is signaled, first SIGTERM and then SIGKILL", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-1", "bash", { command: "rm -rf build" });
        await askToRun(t, "call-1");
      },
    ]);
    fake.answerShutdown = false;
    const { runtime } = setup(fake, { shutdownMs: 20 });

    const result = await runtime.run(runInput({ ask: async () => "defer" }));

    expect(SHUTDOWN_GRACE_MS).toBe(10_000);
    expect(fake.sent("shutdown")).toHaveLength(1);
    expect(fake.kills.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.end).toEqual({ kind: "deferred", callId: "session-1:call-1" });
  });

  test("a call dsh never logged is refused without asking the user, and the run goes on", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await askToRun(t, "unknown-1");
        await t.request("approval/request", { sessionId: t.sessionId, toolName: "bash" });
      },
    ]);
    const gate = recordingAsk(() => "allow");
    const { runtime } = setup(fake);

    const result = await runtime.run(runInput({ ask: gate.ask }));

    expect(fake.serverRequests.map((r) => r.reply)).toEqual([{ outcome: "rejected" }, { outcome: "rejected" }]);
    expect(gate.asks).toEqual([]);
    expect(result.end).toEqual({ kind: "silent" });
  });

  test("dsh's own question tool is turned away, and a request aoa does not know is an error", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.request("user-question/ask", { requestId: "q-1", sessionId: t.sessionId, questions: [{ id: "q1" }] });
        await t.request("session/query", { sessionId: t.sessionId });
      },
    ]);
    const { runtime } = setup(fake);

    await runtime.run(runInput());

    const [question, unknown] = fake.serverRequests.map((r) => r.reply);
    expect(question).toEqual({ cancelled: true });
    expect(unknown).toHaveProperty("error");
  });

  test("an approval the user gave earlier is described as approved but not yet done, to be done again", async () => {
    const fake = new FakeDshServer();
    const { runtime } = setup(fake);
    const answer: RunInput["answer"] = {
      callId: "session-1:call-1",
      tool: "dsh:bash",
      args: { command: "rm -rf build" },
      verdict: "approve",
      result: { status: "ok", output: "approved, not run" },
    };

    await runtime.run(runInput({ session: { id: "session-1", resumed: true, ref: "sess-1", workdir: null }, answer }));

    expect(fake.inputs[0]).toContain("approved");
    expect(fake.inputs[0]).toContain("rm -rf build");
    expect(fake.inputs[0]).toContain("again");
    expect(fake.inputs[0]).not.toContain("already been executed");
  });
});

describe("dshRuntime: aoa's tools over the MCP bridge", () => {
  test("a logged call goes through invoke under <session>:<dsh call id> and its result goes back to dsh", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-9", "mcp__aoa__notify", { body: "done" });
        const reply = await t.mcp("notify", { body: "done" });
        expect(reply).toEqual({ text: '{"sent":true}', isError: false });
      },
    ]);
    const notify = recordingTool("notify", () => ({ status: "ok", output: { sent: true } }));
    const { runtime } = setup(fake);

    const result = await runtime.run(runInput({ tools: [notify.tool] }));

    expect(notify.calls).toEqual([{ callId: "session-1:call-9", args: { body: "done" } }]);
    expect(result.end).toEqual({ kind: "silent" });
  });

  test("a call the bridge cannot place against a logged tool call is an MCP error and does not run", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        const reply = await t.mcp("notify", { body: "done" });
        expect(reply.isError).toBe(true);
        expect(reply.text).toContain("cannot identify");
      },
    ]);
    const notify = recordingTool("notify", () => ({ status: "ok", output: "sent" }));
    const { runtime } = setup(fake);

    await runtime.run(runInput({ tools: [notify.tool] }));

    expect(notify.calls).toEqual([]);
  });

  test("an error result reads as a failed call, and a tool aoa does not serve is refused", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-1", "mcp__aoa__notify", { body: "x" });
        const failed = await t.mcp("notify", { body: "x" });
        expect(failed).toEqual({ text: "Blocked by policy: no.", isError: true });
        const missing = await t.mcp("delete_everything", {});
        expect(missing.isError).toBe(true);
      },
    ]);
    const notify = recordingTool("notify", () => ({ status: "error", error: "Blocked by policy: no." }));
    const { runtime } = setup(fake);

    await runtime.run(runInput({ tools: [notify.tool] }));
  });

  test("a deferred aoa tool tells dsh the user is being asked and stops the run", async () => {
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-1", "mcp__aoa__ask_user", { question: "Which colour?" });
        const reply = await t.mcp("ask_user", { question: "Which colour?" });
        expect(reply.isError).toBe(false);
        expect(reply.text).toContain("user");
      },
    ]);
    const askUser = recordingTool("ask_user", () => ({ status: "deferred" }));
    const { runtime } = setup(fake);

    const result = await runtime.run(runInput({ tools: [askUser.tool] }));

    expect(fake.sent("shutdown")).toHaveLength(1);
    expect(result.end).toEqual({ kind: "deferred", callId: "session-1:call-1" });
  });

  test("each run gets its own loopback endpoint with its own token", async () => {
    const fake = new FakeDshServer();
    const { runtime } = setup(fake);
    const first = await runtime.run(runInput());
    const second = await runtime.run(runInput({ runId: "run-2", session: { id: "session-1", resumed: true, ref: first.sessionRef!, workdir: null } }));

    const url = (i: number) => /^\s+url: (\S+)$/m.exec(fake.patches[i]!)?.[1] ?? "";
    expect(url(0)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/);
    expect(url(1)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/);
    expect(url(0)).not.toBe(url(1));
    expect(second.sessionRef).toBe(first.sessionRef);
  });

  test("a deferred aoa tool that dsh retries is the same kernel call, so the bridge replays instead of running it twice", async () => {
    // Within one run, an entry is claimed once: a second identical call with no new tool/call is refused rather
    // than silently running the same aoa tool twice. The kernel replay across runs is tested in kernel.test.ts.
    const fake = new FakeDshServer([
      async (t) => {
        await t.toolCall("call-1", "mcp__aoa__notify", { body: "done" });
        expect((await t.mcp("notify", { body: "done" })).isError).toBe(false);
        expect((await t.mcp("notify", { body: "done" })).isError).toBe(true);
      },
    ]);
    const notify = recordingTool("notify", () => ({ status: "ok", output: "sent" }));
    const { runtime } = setup(fake);

    await runtime.run(runInput({ tools: [notify.tool] }));

    expect(notify.calls).toHaveLength(1);
  });
});

describe("dshRuntime: the patch and the child", () => {
  test("the patch turns off the capabilities the proposal lists and adds the aoa MCP row", async () => {
    const fake = new FakeDshServer();
    const { runtime, home } = setup(fake);

    await runtime.run(runInput());

    const patch = fake.patch();
    for (const row of DISABLED_ROWS) expect(patch).toContain(`- id: ${row}\n  disabled: true`);
    expect(patch).toContain("- id: aoa-mcp");
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: aoa");
    expect(patch).toContain("transport: streamable-http");
    expect(patch).toMatch(/^\s+url: http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/m);
    expect(patch).toContain("personaSuffix: !!js process.env.AOA_DSH_SYSTEM_PROMPT");
    // The patch is written inside aoa's own dsh home, and read from there by the child it starts.
    const args = fake.launches[0]!.args;
    expect(args.slice(2, 4)).toEqual(["--patch", expect.stringMatching(new RegExp(`^${home}/patches/`))]);
  });

  test("the configured command and preset are what aoa starts, and the version check asks the same command", async () => {
    const fake = new FakeDshServer();
    const { runtime } = setup(fake, { command: "/opt/dsh/bin/dsh", preset: "sdk-app" });

    await runtime.run(runInput());

    expect(fake.versionChecks).toEqual(["/opt/dsh/bin/dsh"]);
    expect(fake.launches[0]!.command).toBe("/opt/dsh/bin/dsh");
    expect(fake.launches[0]!.args.slice(0, 2)).toEqual(["--profile", "sdk-app"]);
  });
});
