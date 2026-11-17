import { describe, expect, test } from "bun:test";
import type { Event, PermissionAsk, RunInput, Tool, ToolResult } from "@aoa/kernel";
import { codexRuntime } from "../src/index.ts";
import { FakeAppServer, dyingProcess, type FakeTurn } from "./fake-app-server.ts";

const INSTRUCTIONS = "You are a test agent.";

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

const commandApproval = (t: FakeTurn, itemId: string, command = "rm -rf build", extra: object = {}) =>
  t.request("item/commandExecution/requestApproval", {
    threadId: t.threadId,
    turnId: t.turnId,
    itemId,
    kind: "command",
    startedAtMs: 0,
    environmentId: null,
    command,
    cwd: "/work/tree",
    reason: "clean before rebuilding",
    ...extra,
  });

const setup = (fake: FakeAppServer) => codexRuntime({ developerInstructions: INSTRUCTIONS, cwd: "/repo", spawn: fake.spawn });

describe("codexRuntime", () => {
  test("a new session starts a thread in its workdir with aoa's instructions and tools; the ref is the thread id", async () => {
    const fake = new FakeAppServer();
    const notify = recordingTool("notify", () => ({ status: "ok", output: "sent" }));

    const result = await setup(fake).run(runInput({ tools: [notify.tool] }));

    expect(fake.spawns).toEqual(["/work/tree"]);
    expect(fake.received[0]).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: true } } });
    expect(fake.sent("thread/start")).toEqual([
      {
        cwd: "/work/tree",
        developerInstructions: INSTRUCTIONS,
        dynamicTools: [{ type: "function", name: "notify", description: "Test tool notify.", inputSchema: notify.tool.schema }],
      },
    ]);
    // aoa leaves the approval policy and the sandbox to the user's Codex configuration.
    expect(fake.sent("thread/start")[0]).not.toHaveProperty("approvalPolicy");
    expect(fake.sent("thread/start")[0]).not.toHaveProperty("sandbox");
    expect(fake.inputs[0]).toContain("fix the widget");
    expect(result).toEqual({ end: { kind: "silent" }, sessionRef: "thread-1" });
    expect(fake.live).toBe(0);
  });

  test("a resumed session resumes its thread and passes the configured model", async () => {
    const fake = new FakeAppServer();
    const runtime = codexRuntime({ developerInstructions: INSTRUCTIONS, cwd: "/repo", model: "gpt-test", spawn: fake.spawn });

    const result = await runtime.run(runInput({ session: { id: "session-1", resumed: true, ref: "thread-77", workdir: null } }));

    expect(fake.spawns).toEqual(["/repo"]);
    expect(fake.sent("thread/start")).toEqual([]);
    expect(fake.sent("thread/resume")).toEqual([
      { threadId: "thread-77", cwd: "/repo", developerInstructions: INSTRUCTIONS, model: "gpt-test" },
    ]);
    expect(result.sessionRef).toBe("thread-77");
  });

  test("auto review: a new and a resumed thread route Codex's approvals to its own reviewer; the sandbox stays the user's", async () => {
    const fresh = new FakeAppServer();
    const resumed = new FakeAppServer();
    const autoReview = (fake: FakeAppServer) =>
      codexRuntime({ developerInstructions: INSTRUCTIONS, cwd: "/repo", autoReview: true, spawn: fake.spawn });

    await autoReview(fresh).run(runInput());
    await autoReview(resumed).run(runInput({ session: { id: "session-1", resumed: true, ref: "thread-77", workdir: null } }));

    for (const params of [fresh.sent("thread/start")[0], resumed.sent("thread/resume")[0]]) {
      expect(params).toMatchObject({ approvalsReviewer: "auto_review" });
      expect(params).not.toHaveProperty("sandbox");
      expect(params).not.toHaveProperty("approvalPolicy");
    }
  });

  describe("approval requests go through the kernel gate", () => {
    test("allow: Codex is told accept, once", async () => {
      const fake = new FakeAppServer([async (t) => void (await commandApproval(t, "item-1"))]);
      const gate = recordingAsk(() => "allow");

      const result = await setup(fake).run(runInput({ ask: gate.ask }));

      expect(gate.asks).toEqual([
        {
          callId: "session-1:turn-1:item-1",
          tool: "codex_command",
          args: { command: "rm -rf build", cwd: "/work/tree" },
          reason: "clean before rebuilding",
        },
      ]);
      expect(fake.serverRequests[0]!.reply).toEqual({ decision: "accept" });
      expect(result.end).toEqual({ kind: "silent" });
    });

    test("defer: Codex is told decline, the turn is interrupted and the run ends deferred", async () => {
      const fake = new FakeAppServer([
        async (t) => {
          await commandApproval(t, "item-1");
          // Codex may ask again before the interrupt lands: declined without asking the gate.
          await commandApproval(t, "item-2", "ls");
        },
      ]);
      const gate = recordingAsk(() => "defer");

      const result = await setup(fake).run(runInput({ ask: gate.ask }));

      expect(fake.serverRequests.map((r) => r.reply)).toEqual([{ decision: "decline" }, { decision: "decline" }]);
      expect(fake.sent("turn/interrupt")).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
      expect(gate.asks).toHaveLength(1);
      expect(result).toEqual({ end: { kind: "deferred", callId: "session-1:turn-1:item-1" }, sessionRef: "thread-1" });
      expect(fake.live).toBe(0);
    });

    test("the gate sees what identifies the action: extra permissions and stdin input are part of a command", async () => {
      const fake = new FakeAppServer([
        async (t) => {
          await commandApproval(t, "item-1", "curl example.com", { additionalPermissions: { network: { enabled: true } } });
          await commandApproval(t, "item-2", "y", { kind: "writeStdin", approvalId: "cb-1" });
          await commandApproval(t, "item-2", "y", { kind: "writeStdin", approvalId: "cb-2" });
        },
      ]);
      const gate = recordingAsk(() => "allow");

      await setup(fake).run(runInput({ ask: gate.ask }));

      expect(gate.asks.map((a) => [a.callId, a.args])).toEqual([
        ["session-1:turn-1:item-1", { command: "curl example.com", cwd: "/work/tree", additionalPermissions: { network: { enabled: true } } }],
        ["session-1:turn-1:item-2:cb-1", { command: "y", cwd: "/work/tree", kind: "writeStdin" }],
        ["session-1:turn-1:item-2:cb-2", { command: "y", cwd: "/work/tree", kind: "writeStdin" }],
      ]);
    });

    test("one item asking twice gets two call ids, so the second ask is not an already answered call", async () => {
      const fake = new FakeAppServer([
        async (t) => {
          await commandApproval(t, "item-1");
          await commandApproval(t, "item-1");
        },
      ]);
      const gate = recordingAsk(() => "allow");

      await setup(fake).run(runInput({ ask: gate.ask }));

      expect(gate.asks.map((a) => a.callId)).toEqual(["session-1:turn-1:item-1", "session-1:turn-1:item-1#1"]);
    });

    test("a file change is identified by the changes its item carries, so the same change asked again is equal", async () => {
      const changes = [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "-a\n+b\n" }];
      // Codex may carry the changes on the item when it starts, or send them in a patch update afterwards.
      const fileChange = async (t: FakeTurn, itemId: string, patchUpdate: boolean) => {
        const item = { type: "fileChange", id: itemId, changes: patchUpdate ? [] : changes, status: "inProgress" };
        t.notify("item/started", { threadId: t.threadId, turnId: t.turnId, item });
        if (patchUpdate) t.notify("item/fileChange/patchUpdated", { threadId: t.threadId, turnId: t.turnId, itemId, changes });
        return t.request("item/fileChange/requestApproval", { threadId: t.threadId, turnId: t.turnId, itemId, startedAtMs: 0, reason: null });
      };
      const fake = new FakeAppServer([
        async (t) => {
          await fileChange(t, "item-1", true);
          await fileChange(t, "item-2", false);
        },
      ]);
      const gate = recordingAsk(() => "allow");

      await setup(fake).run(runInput({ ask: gate.ask }));

      expect(gate.asks.map((a) => [a.tool, a.args])).toEqual([
        ["codex_file_change", { changes }],
        ["codex_file_change", { changes }],
      ]);
      expect(fake.serverRequests.map((r) => r.reply)).toEqual([{ decision: "accept" }, { decision: "accept" }]);
    });

    test("an ask whose action is unknown cannot match an earlier grant", async () => {
      // A file change whose item was never seen, and a command with nothing to name it, are asked about as themselves.
      const fake = new FakeAppServer([
        async (t) => {
          await t.request("item/fileChange/requestApproval", { threadId: t.threadId, turnId: t.turnId, itemId: "item-1", startedAtMs: 0 });
          await t.request("item/fileChange/requestApproval", { threadId: t.threadId, turnId: t.turnId, itemId: "item-2", startedAtMs: 0 });
          await commandApproval(t, "item-3", null as unknown as string, { cwd: null });
          await commandApproval(t, "item-4", null as unknown as string, { cwd: null });
        },
      ]);
      const gate = recordingAsk(() => "allow");

      await setup(fake).run(runInput({ ask: gate.ask }));

      const [a, b, c, d] = gate.asks.map((x) => x.args);
      expect(a).not.toEqual(b);
      expect(c).not.toEqual(d);
    });

    test("a permissions request is granted for the turn on allow and grants nothing on defer", async () => {
      const permissions = { network: { enabled: true }, fileSystem: null };
      const ask = (t: FakeTurn) =>
        t.request("item/permissions/requestApproval", {
          threadId: t.threadId,
          turnId: t.turnId,
          itemId: "item-1",
          environmentId: null,
          startedAtMs: 0,
          cwd: "/work/tree",
          reason: "needs the network",
          permissions,
        });
      const allowed = new FakeAppServer([async (t) => void (await ask(t))]);
      const deferred = new FakeAppServer([async (t) => void (await ask(t))]);
      const gate = recordingAsk(() => "allow");

      await setup(allowed).run(runInput({ ask: gate.ask }));
      await setup(deferred).run(runInput({ ask: async () => "defer" }));

      expect(gate.asks[0]).toMatchObject({ tool: "codex_permissions", args: { permissions, cwd: "/work/tree" } });
      expect(allowed.serverRequests[0]!.reply).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
      expect(deferred.serverRequests[0]!.reply).toEqual({ permissions: {}, scope: "turn" });
    });
  });

  describe("aoa's tools as dynamic tools", () => {
    const toolCall = (t: FakeTurn, callId: string, tool: string, args: object) =>
      t.request("item/tool/call", { threadId: t.threadId, turnId: t.turnId, callId, namespace: null, tool, arguments: args });

    test("a call goes through invoke under a call id derived from Codex's, and the result goes back", async () => {
      const fake = new FakeAppServer([async (t) => void (await toolCall(t, "call-9", "notify", { body: "done" }))]);
      const notify = recordingTool("notify", () => ({ status: "ok", output: { sent: true } }));

      const result = await setup(fake).run(runInput({ tools: [notify.tool] }));

      expect(notify.calls).toEqual([{ callId: "session-1:turn-1:call-9", args: { body: "done" } }]);
      expect(fake.serverRequests[0]!.reply).toEqual({ contentItems: [{ type: "inputText", text: '{"sent":true}' }], success: true });
      expect(result.end).toEqual({ kind: "silent" });
    });

    test("an error result is a failed call", async () => {
      const fake = new FakeAppServer([async (t) => void (await toolCall(t, "call-1", "notify", { body: "x" }))]);
      const notify = recordingTool("notify", () => ({ status: "error", error: "Blocked by policy: no." }));

      await setup(fake).run(runInput({ tools: [notify.tool] }));

      expect(fake.serverRequests[0]!.reply).toEqual({ contentItems: [{ type: "inputText", text: "Blocked by policy: no." }], success: false });
    });

    test("a deferred call interrupts the turn and ends the run deferred", async () => {
      const fake = new FakeAppServer([async (t) => void (await toolCall(t, "call-1", "ask_user", { question: "Which colour?" }))]);
      const askUser = recordingTool("ask_user", () => ({ status: "deferred" }));

      const result = await setup(fake).run(runInput({ tools: [askUser.tool] }));

      expect(fake.serverRequests[0]!.reply.contentItems[0].text).toContain("user");
      expect(fake.sent("turn/interrupt")).toHaveLength(1);
      expect(result.end).toEqual({ kind: "deferred", callId: "session-1:turn-1:call-1" });
    });

    test("Codex's own question tool is turned away towards ask_user; MCP elicitations are declined", async () => {
      const fake = new FakeAppServer([
        async (t) => {
          await t.request("item/tool/requestUserInput", {
            threadId: t.threadId,
            turnId: t.turnId,
            itemId: "item-1",
            questions: [{ id: "q1", header: "Colour", question: "Which?", isOther: false, isSecret: false, options: null }],
            isBlocking: true,
            autoResolutionMs: null,
          });
          await t.request("mcpServer/elicitation/request", { threadId: t.threadId, turnId: t.turnId, serverName: "x" });
          await t.request("currentTime/read", {});
        },
      ]);

      await setup(fake).run(runInput());

      const [input, elicitation, unknown] = fake.serverRequests.map((r) => r.reply);
      expect(input.answers.q1.answers[0]).toContain("ask_user");
      expect(elicitation).toEqual({ action: "decline", content: null, _meta: null });
      expect(unknown).toHaveProperty("error");
    });
  });

  test("an answered harness call is described as approved but not yet done, to be done again", async () => {
    const fake = new FakeAppServer();
    const answer: RunInput["answer"] = {
      callId: "session-1:turn-1:item-1",
      tool: "codex_command",
      args: { command: "rm -rf build", cwd: "/work/tree" },
      verdict: "approve",
      result: { status: "ok", output: "approved, not run" },
    };

    await setup(fake).run(runInput({ answer }));

    expect(fake.inputs[0]).toContain("rm -rf build");
    expect(fake.inputs[0]).toContain("again");
    expect(fake.inputs[0]).not.toContain("already been executed");
  });

  test("a denied harness call is described as not done, not to be tried again, with the user's words", async () => {
    const fake = new FakeAppServer();
    const answer: RunInput["answer"] = {
      callId: "session-1:turn-1:item-1",
      tool: "codex_command",
      args: { command: "rm -rf build", cwd: "/work/tree" },
      verdict: "deny",
      text: "keep the cache",
    };

    await setup(fake).run(runInput({ answer }));

    expect(fake.inputs[0]).toContain("denied");
    expect(fake.inputs[0]).toContain("rm -rf build");
    expect(fake.inputs[0]).toContain("keep the cache");
    expect(fake.inputs[0]).not.toContain("Do it again");
  });

  test("a failed turn, a process that dies mid-turn and one that never starts all fail the run", async () => {
    const failing = new FakeAppServer([async () => ({ failed: "usage limit reached" })]);
    const dying = new FakeAppServer([async (t) => t.die("codex app-server exited with code 137")]);

    await expect(setup(failing).run(runInput())).rejects.toThrow("usage limit reached");
    await expect(setup(dying).run(runInput())).rejects.toThrow("code 137");
    await expect(codexRuntime({ developerInstructions: "", cwd: "/repo", spawn: dyingProcess }).run(runInput())).rejects.toThrow("not logged in");
  });
});
