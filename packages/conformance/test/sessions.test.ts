import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SimulatedCrash,
  addFollowUp,
  closeSession,
  retryDelayMs,
  type Rule,
  type Session,
  type ToolDef,
} from "@aoa/kernel";
import { FakeChannel, Harness, ScriptedRuntime, countingTool, crashAt, storeFactories } from "../src/index.ts";

const whereAmI: ToolDef = {
  name: "where_am_i",
  description: "Returns the session's working directory",
  schema: { type: "object" },
  async execute(_args, ctx) {
    return ctx.workdir;
  },
};

for (const [name, factory] of storeFactories) {
  describe(`sessions [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("prepareSession gives a new session its workdir before the run, once per session", async () => {
      const prepared: string[] = [];
      const prepareSession = async (s: Session) => {
        prepared.push(s.id);
        return { workdir: `/work/${s.id}` };
      };
      const call = { calls: [{ tool: "where_am_i", callId: "call-1" }] };
      const runtime = new ScriptedRuntime([call, { calls: [{ tool: "where_am_i", callId: "call-2" }] }]);
      const worker = h.worker({ runtime, tools: [whereAmI], prepareSession });

      h.append({ thread: "task-1" });
      await worker.drain();
      h.append({ thread: "task-1" });
      await worker.drain();

      const session = runtime.runs[0]!.input.session.id;
      expect(prepared).toEqual([session]);
      expect(runtime.runs.map((r) => r.input.session.workdir)).toEqual([`/work/${session}`, `/work/${session}`]);
      expect(runtime.runs.map((r) => r.toolResults[0])).toEqual([
        { status: "ok", output: `/work/${session}` },
        { status: "ok", output: `/work/${session}` },
      ]);
    });

    test("a crash after preparing keeps the workdir, so the retry does not prepare again", async () => {
      let prepared = 0;
      const prepareSession = async () => ({ workdir: `/work/${++prepared}` });
      h.append();
      const runtime = new ScriptedRuntime();
      await expect(h.worker({ runtime, prepareSession, crash: crashAt("before_complete") }).drain()).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      h.waitOutLease();
      await h.worker({ runtime, prepareSession, store: h.connect() }).drain();
      expect(runtime.runs.map((r) => r.input.session.workdir)).toEqual(["/work/1", "/work/1"]);
      expect(prepared).toBe(1);
    });

    test("a failing prepareSession releases the events for a retry instead of holding them until the lease ends", async () => {
      const { id } = h.append();
      let calls = 0;
      const prepareSession = async () => {
        if (++calls === 1) throw new Error("worktree busy");
        return { workdir: "/work/ok" };
      };
      const runtime = new ScriptedRuntime();
      const worker = h.worker({ runtime, prepareSession });

      expect((await worker.drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "pending", attempts: 1 });
      h.clock.advance(retryDelayMs(1));
      expect((await worker.drain()).runs).toBe(1);
      expect(h.store.tx((t) => t.getEvent(id))).toMatchObject({ status: "done", attempts: 1 });
      expect(h.runs().map((r) => r.error)).toEqual(["worktree busy", null]);
      expect(runtime.runs.map((r) => r.input.session.workdir)).toEqual(["/work/ok"]);
    });

    test("the primary thread is the first one registered for the session", async () => {
      h.append({ thread: "github:o/r#1" });
      const runtime = new ScriptedRuntime();
      await h.worker({ runtime }).drain();
      const session = runtime.runs[0]!.input.session.id;
      h.store.tx((t) => t.registerThread(h.inboxId, "github:o/r#7", session));
      expect(h.store.tx((t) => t.primaryThread(session))).toBe("github:o/r#1");
    });

    test("closing a session cancels its timers; a new event on its thread reopens it", async () => {
      h.append({ thread: "task-1" });
      const runtime = new ScriptedRuntime();
      const worker = h.worker({ runtime });
      await worker.drain();
      const session = runtime.runs[0]!.input.session.id;
      const timer = addFollowUp(h.store, h.inboxId, { sessionId: session, due: h.clock.now() + 60_000, payload: {} });

      closeSession(h.store, session);
      expect(h.store.tx((t) => t.getSession(session))?.status).toBe("closed");
      expect(h.store.tx((t) => t.getTimer(timer.id))?.status).toBe("cancelled");

      h.append({ thread: "task-1" });
      await worker.drain();
      expect(runtime.runs[1]!.input.session).toMatchObject({ id: session, resumed: true });
      expect(h.store.tx((t) => t.getSession(session))?.status).toBe("open");
    });

    test("closing a session that waits on a call drops the call, so the reopened session works", async () => {
      const deploy = countingTool("deploy");
      const lint = countingTool("lint");
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1" }] }, { calls: [{ tool: "lint", callId: "call-2" }] }]);
      const worker = h.worker({ runtime, tools: [deploy, lint], policy: { risk: { lint: "low" } } });
      h.append({ thread: "task-1" });
      await worker.drain();
      const session = runtime.runs[0]!.input.session.id;

      closeSession(h.store, session);
      expect(h.store.tx((t) => t.getDeferred("call-1"))).toBeNull();
      h.append({ thread: "task-1", payload: { text: "start over" } });
      await worker.drain();

      expect(runtime.runs[1]!.input.events.map((e) => e.source)).toEqual(["user_message"]);
      expect(runtime.runs[1]!.toolResults).toEqual([{ status: "ok", output: { done: 1 } }]);
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "open", pending: null });
    });

    test("closing a session before its approval request went out cancels the request", async () => {
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1" }] }]);
      h.append({ thread: "task-1" });
      await h.worker({ runtime, tools: [countingTool("deploy")], policy: { risk: {} } }).drain();

      closeSession(h.store, runtime.runs[0]!.input.session.id);
      const channel = new FakeChannel();
      await h.dispatcher({ channel }).pass();

      expect(channel.calls).toEqual([]);
      expect(h.outbox().map((m) => [m.kind, m.status])).toEqual([["approval_request", "cancelled"]]);
    });

    test("policy rules see the session's workdir", async () => {
      const seen: (string | null)[] = [];
      const rule: Rule = {
        name: "spy",
        match(_call, ctx) {
          seen.push(ctx.workdir);
          return null;
        },
      };
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "where_am_i", callId: "call-1" }] }]);
      const prepareSession = async (s: Session) => ({ workdir: `/work/${s.id}` });
      h.append();
      await h.worker({ runtime, tools: [whereAmI], prepareSession, policy: { risk: { where_am_i: "low" }, rules: [rule] } }).drain();

      expect(seen).toEqual([`/work/${runtime.runs[0]!.input.session.id}`]);
    });
  });
}
