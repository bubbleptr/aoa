import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SimulatedCrash, answerDeferred } from "@aoa/kernel";
import { Harness, ScriptedRuntime, countingTool, crashAt, storeFactories, type CountingTool, type RunScript } from "../src/index.ts";

const THREAD = "github:o/r#1";
const deployCall: RunScript = { calls: [{ tool: "deploy", callId: "call-1", args: { env: "prod" } }] };

for (const [name, factory] of storeFactories) {
  describe(`C16 an answer takes effect once [${name}]`, () => {
    let h: Harness;
    let deploy: CountingTool;
    beforeEach(() => {
      h = new Harness(factory());
      deploy = countingTool("deploy");
    });
    afterEach(() => h.dispose());

    const worker = (runtime: ScriptedRuntime, o: { crash?: ReturnType<typeof crashAt>; store?: ReturnType<Harness["connect"]> } = {}) =>
      h.worker({ runtime, tools: [deploy], policy: { risk: {} }, ...o });

    async function deferDeploy(runtime: ScriptedRuntime) {
      h.append({ thread: THREAD });
      await worker(runtime).drain();
      return runtime.runs[0]!.input.session.id;
    }

    test("two approvals and a CLI answer for one call: one answer event, one execution", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      const session = await deferDeploy(runtime);

      const first = h.append({ thread: THREAD, payload: { text: "/approve go ahead" } });
      const second = h.append({ thread: THREAD, payload: { text: "/approve" } });
      const cli = answerDeferred(h.store, h.clock, h.inboxId, "call-1", "approve");
      expect([first.status, second.status, cli.status]).toEqual(["pending", "dropped", "dropped"]);
      expect(h.store.tx((t) => t.getEvent(first.id))).toMatchObject({
        source: "approval_answer",
        dedupeKey: "answer:call-1",
        resume: session,
        payload: { callId: "call-1", verdict: "approve", text: "go ahead" },
      });

      await worker(runtime).drain();
      expect(deploy.effects).toEqual([{ env: "prod" }]);
      const resumed = runtime.runs[1]!.input;
      expect(resumed.answer).toEqual({
        callId: "call-1",
        tool: "deploy",
        args: { env: "prod" },
        verdict: "approve",
        text: "go ahead",
        result: { status: "ok", output: { done: 1 } },
      });
      // The resumed transcript replays the call; the journal answers it.
      expect(runtime.runs[1]!.toolResults).toEqual([{ status: "ok", output: { done: 1 } }]);
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "open", pending: null });
      expect(h.store.tx((t) => t.getDeferred("call-1"))).toBeNull();
      expect(h.runs().map((r) => r.end)).toEqual([{ kind: "deferred", callId: "call-1" }, { kind: "silent" }]);
    });

    test("a redelivered reply is dropped: it cannot answer a later call, nor come back as a new message", async () => {
      const deployAgain: RunScript = { calls: [{ tool: "deploy", callId: "call-2" }] };
      const runtime = new ScriptedRuntime([deployCall, deployAgain, {}]);
      const session = await deferDeploy(runtime);
      const reply = { thread: THREAD, dedupeKey: "github:comment:55", payload: { text: "/approve" } };

      expect(h.append(reply).status).toBe("pending");
      await worker(runtime).drain();
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "paused", pending: "call-2" });
      expect(h.append(reply).status).toBe("dropped");
      expect(h.store.tx((t) => t.getSession(session))?.pending).toBe("call-2");

      h.append({ thread: THREAD, payload: { text: "/deny" } });
      await worker(runtime).drain();
      expect(h.store.tx((t) => t.getSession(session))?.status).toBe("open");
      expect(h.append(reply).status).toBe("dropped");
      expect(deploy.effects).toHaveLength(1);
    });

    test("a crash between executing the approved call and recording it: never executed twice", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall]);
      await deferDeploy(runtime);
      h.append({ thread: THREAD, payload: { text: "/approve" } });

      await expect(worker(runtime, { crash: crashAt("after_tool_exec") }).drain()).rejects.toBeInstanceOf(SimulatedCrash);
      expect(deploy.effects).toHaveLength(1);
      h.waitOutLease();
      await worker(runtime, { store: h.connect() }).drain();

      expect(deploy.effects).toHaveLength(1);
      expect(runtime.runs[1]!.input.answer).toMatchObject({ verdict: "approve", result: { status: "unknown" } });
    });

    test("a crash after the answer was applied: the rerun still gets the whole answer", async () => {
      const runtime = new ScriptedRuntime([deployCall, deployCall, deployCall]);
      const session = await deferDeploy(runtime);
      h.append({ thread: THREAD, payload: { text: "/approve" } });

      await expect(worker(runtime, { crash: crashAt("before_complete") }).drain()).rejects.toBeInstanceOf(SimulatedCrash);
      expect(h.store.tx((t) => t.getSession(session))?.status).toBe("open");
      h.waitOutLease();
      await worker(runtime, { store: h.connect() }).drain();

      expect(deploy.effects).toHaveLength(1);
      expect(runtime.runs[2]!.input.answer).toEqual(runtime.runs[1]!.input.answer);
      expect(runtime.runs[2]!.input.answer).toMatchObject({ tool: "deploy", args: { env: "prod" }, result: { status: "ok" } });
    });
  });
}
