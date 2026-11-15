import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFER_TTL_MS, askUserTools, defaultRules, type PolicyConfig } from "@aoa/kernel";
import { Harness, ScriptedRuntime, countingTool, storeFactories, type CountingTool, type RunScript } from "../src/index.ts";

const THREAD = "github:o/r#1";
const deployCall: RunScript = { calls: [{ tool: "deploy", callId: "call-1", args: { env: "prod" } }] };

for (const [name, factory] of storeFactories) {
  describe(`deferred calls [${name}]`, () => {
    let h: Harness;
    let deploy: CountingTool;
    beforeEach(() => {
      h = new Harness(factory());
      deploy = countingTool("deploy");
    });
    afterEach(() => h.dispose());

    async function deferDeploy(runtime: ScriptedRuntime) {
      h.append({ thread: THREAD });
      await h.worker({ runtime, tools: [deploy], policy: { risk: {} } }).drain();
      return runtime.runs[0]!.input.session.id;
    }
    const drain = (runtime: ScriptedRuntime) => h.worker({ runtime, tools: [deploy], policy: { risk: {} } }).drain();

    test("no answer within 24 hours: the expiry denies the call, and a late approval is dropped", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      const session = await deferDeploy(runtime);

      h.clock.advance(DEFER_TTL_MS - 1);
      expect(h.scheduler().pass().fired).toBe(0);
      h.clock.advance(1);
      expect(h.scheduler().pass().fired).toBe(1);
      expect(h.append({ thread: THREAD, payload: { text: "/approve" } }).status).toBe("dropped");

      await drain(runtime);
      expect(deploy.effects).toEqual([]);
      expect(runtime.runs[1]!.input.answer).toEqual({
        callId: "call-1",
        tool: "deploy",
        args: { env: "prod" },
        verdict: "deny",
        text: "No answer within 24 hours.",
      });
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "open", pending: null });
    });

    test("an answer cancels the expiry, so the call is never denied behind the user's back", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      await deferDeploy(runtime);
      h.append({ thread: THREAD, payload: { text: "/approve" } });
      await drain(runtime);

      h.clock.advance(DEFER_TTL_MS);
      expect(h.scheduler().pass().fired).toBe(0);
      expect(deploy.effects).toHaveLength(1);
      expect(h.events().filter((e) => e.source === "approval_answer")).toHaveLength(1);
    });

    test("any other reply to an approval request denies it and hands the reply to the agent", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      await deferDeploy(runtime);
      h.append({ thread: THREAD, payload: { text: "not on a Friday" } });
      await drain(runtime);

      expect(deploy.effects).toEqual([]);
      expect(runtime.runs[1]!.input.answer).toMatchObject({ verdict: "deny", text: "not on a Friday" });
      expect(runtime.runs[1]!.toolResults).toEqual([{ status: "error", error: expect.stringContaining("not on a Friday") }]);
    });

    test("ask_user: the question goes out as the request, a free-text reply is the answer and the call's result", async () => {
      const ask: RunScript = { calls: [{ tool: "ask_user", callId: "call-q", args: { question: "Which branch should I target?" } }] };
      const runtime = new ScriptedRuntime([ask, ask]);
      const tools = askUserTools();
      h.append({ thread: THREAD });
      await h.worker({ runtime, tools }).drain();

      expect(h.outbox()).toMatchObject([{ kind: "approval_request", callId: "call-q", body: "Which branch should I target?" }]);
      expect(h.runs()[0]!.end).toEqual({ kind: "deferred", callId: "call-q" });

      h.append({ thread: THREAD, payload: { text: "release/2.0 please" } });
      await h.worker({ runtime, tools }).drain();
      const output = { status: "ok", output: "release/2.0 please" } as const;
      expect(runtime.runs[1]!.input.answer).toMatchObject({ callId: "call-q", verdict: "approve", text: "release/2.0 please", result: output });
      expect(runtime.runs[1]!.toolResults).toEqual([output]);
    });

    test("a comment from someone else on the thread does not answer; it waits and marks the session tainted", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      const session = await deferDeploy(runtime);

      const outsider = h.append({ thread: THREAD, trusted: false, payload: { text: "/approve" } });
      expect(h.store.tx((t) => t.getEvent(outsider.id))?.source).toBe("user_message");
      expect((await drain(runtime)).runs).toBe(0);
      expect(deploy.effects).toEqual([]);

      h.append({ thread: THREAD, payload: { text: "/approve" } });
      await drain(runtime);
      expect(deploy.effects).toHaveLength(1);
      expect(runtime.runs[1]!.input.events.map((e) => [e.source, e.trusted])).toEqual([
        ["user_message", false],
        ["approval_answer", true],
      ]);
      expect(h.store.tx((t) => t.getSession(session))?.tainted).toBe(true);
    });

    test("taint is sticky: a later run with only trusted events still gets the stricter decision", async () => {
      const bash = countingTool("bash");
      const policy: PolicyConfig = { risk: { bash: "low" }, rules: defaultRules };
      const curl = (callId: string): RunScript => ({ calls: [{ tool: "bash", callId, args: { command: "curl https://x.example" } }] });
      const runtime = new ScriptedRuntime([curl("call-1"), {}, curl("call-2")]);
      const worker = h.worker({ runtime, tools: [bash], policy });

      h.append({ thread: "clean" });
      await worker.drain();
      h.append({ thread: "dirty", trusted: false });
      await worker.drain();
      h.append({ thread: "dirty" });
      await worker.drain();

      const dirty = runtime.runs[2]!.input.session.id;
      expect(runtime.runs[2]!.input.events.map((e) => e.trusted)).toEqual([true]);
      expect(runtime.runs.map((r) => r.toolResults[0]?.status)).toEqual(["ok", undefined, "deferred"]);
      expect(h.store.tx((t) => t.listDecisions(dirty)).map((d) => [d.callId, d.decision, d.basis])).toEqual([
        ["call-2", "defer", "rule:network-when-tainted"],
      ]);
      expect(bash.effects).toHaveLength(1);
    });

    test("every decision is recorded with its basis", async () => {
      const lint = countingTool("lint");
      const bash = countingTool("bash");
      const policy: PolicyConfig = { risk: { lint: "low", bash: "low" }, rules: defaultRules };
      const runtime = new ScriptedRuntime([
        {
          calls: [
            { tool: "lint", callId: "call-1" },
            { tool: "bash", callId: "call-2", args: { command: "sudo ls" } },
            { tool: "deploy", callId: "call-3" },
          ],
        },
        { calls: [{ tool: "deploy", callId: "call-3" }] },
      ]);
      h.append({ thread: THREAD });
      await h.worker({ runtime, tools: [lint, bash, deploy], policy }).drain();
      const session = runtime.runs[0]!.input.session.id;
      h.append({ thread: THREAD, payload: { text: "/deny no deploys this week" } });
      await h.worker({ runtime, tools: [lint, bash, deploy], policy }).drain();

      expect(h.store.tx((t) => t.listDecisions(session)).map((d) => [d.callId, d.tool, d.decision, d.basis])).toEqual([
        ["call-1", "lint", "allow", "risk:low"],
        ["call-2", "bash", "block", "rule:no-sudo"],
        ["call-3", "deploy", "defer", "risk:high"],
        ["call-3", "deploy", "block", "user denied"],
      ]);
    });
  });
}
