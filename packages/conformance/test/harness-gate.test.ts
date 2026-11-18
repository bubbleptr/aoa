import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFER_TTL_MS } from "../src/kernel.ts";
import { Harness, ScriptedRuntime, storeFactories, type RunScript, type ScriptedCall } from "../src/index.ts";

const THREAD = "github:o/r#1";
const command = (callId: string, cmd = "rm -rf build"): ScriptedCall => ({
  tool: "command",
  callId,
  args: { command: cmd, cwd: "/work" },
  harness: true,
});
const asks = (...calls: ScriptedCall[]): RunScript => ({ calls });

/** A tier-2 runtime: it asks for its own calls, and the kernel holds untrusted input for it. */
const harness = (scripts: RunScript[] = []) => new ScriptedRuntime(scripts, { kind: "harness" });

for (const [name, factory] of storeFactories) {
  describe(`harness permission gate [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    const drain = (runtime: ScriptedRuntime) => h.worker({ runtime }).drain();
    const requests = () => h.outbox().filter((m) => m.kind === "approval_request");
    const reply = (text: string) => h.append({ thread: THREAD, payload: { text } });

    /** Runs the first script: the harness asks for `call-1` and the session pauses on it. */
    async function askFirst(runtime: ScriptedRuntime) {
      h.append({ thread: THREAD });
      await drain(runtime);
      return runtime.runs[0]!.input.session.id;
    }

    test("the harness asks: one approval request, the session pauses, the run ends deferred", async () => {
      const runtime = harness([asks({ ...command("call-1"), reason: "clean before rebuilding" }, command("call-2", "ls"))]);
      const session = await askFirst(runtime);

      expect(runtime.runs[0]!.asks).toEqual(["defer", "defer"]);
      expect(requests()).toMatchObject([{ callId: "call-1", body: expect.stringContaining("rm -rf build") }]);
      expect(requests()[0]!.body).toContain("clean before rebuilding");
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "paused", pending: "call-1" });
      expect(h.runs()[0]!.end).toEqual({ kind: "deferred", callId: "call-1" });
      expect(runtime.harnessEffects).toEqual([]);
      expect(h.store.tx((t) => t.listDecisions(session)).map((d) => [d.callId, d.decision])).toEqual([["call-1", "defer"]]);
    });

    test("approve: the answer says so, the same call is allowed once, a third ask is deferred again", async () => {
      // The same arguments with their keys in another order are the same call.
      const reordered: ScriptedCall = { ...command("call-2"), args: { cwd: "/work", command: "rm -rf build" } };
      const runtime = harness([asks(command("call-1")), asks(reordered, command("call-3"))]);
      const session = await askFirst(runtime);
      reply("/approve");
      await drain(runtime);

      expect(runtime.runs[1]!.input.answer).toMatchObject({
        callId: "call-1",
        tool: "command",
        args: { command: "rm -rf build", cwd: "/work" },
        verdict: "approve",
        result: { status: "ok", output: expect.stringContaining("again") },
      });
      expect(runtime.runs[1]!.asks).toEqual(["allow", "defer"]);
      expect(runtime.harnessEffects).toEqual([{ tool: "command", args: { command: "rm -rf build", cwd: "/work" } }]);
      expect(requests().map((m) => m.callId)).toEqual(["call-1", "call-3"]);
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "paused", pending: "call-3" });
      expect(h.store.tx((t) => t.listDecisions(session)).map((d) => [d.callId, d.decision])).toEqual([
        ["call-1", "defer"],
        ["call-1", "allow"],
        ["call-2", "allow"],
        ["call-3", "defer"],
      ]);
    });

    test("a grant covers only the arguments that were approved", async () => {
      const runtime = harness([asks(command("call-1")), asks(command("call-2", "rm -rf src"))]);
      await askFirst(runtime);
      reply("/approve");
      await drain(runtime);

      expect(runtime.runs[1]!.asks).toEqual(["defer"]);
      expect(runtime.harnessEffects).toEqual([]);
      expect(requests().map((m) => m.callId)).toEqual(["call-1", "call-2"]);
    });

    test("an approved ask replays as allowed when a failed run is retried, without asking again", async () => {
      const runtime = harness([
        asks(command("call-1")),
        { ...asks(command("call-2")), fail: new Error("harness crashed") },
        asks(command("call-2")),
      ]);
      await askFirst(runtime);
      reply("/approve");
      await drain(runtime);
      h.clock.advance(60_000);
      await drain(runtime);

      expect(runtime.runs.map((r) => r.asks)).toEqual([["defer"], ["allow"], ["allow"]]);
      expect(requests()).toHaveLength(1);
    });

    test.each([
      ["deny", () => "/deny not today", { verdict: "deny", text: "not today" }],
      ["expiry", null, { verdict: "deny", text: "No answer within 24 hours." }],
    ] as const)("%s: the answer carries the denial and no grant is left", async (_label, text, expected) => {
      const runtime = harness([asks(command("call-1")), asks(command("call-2"))]);
      const session = await askFirst(runtime);
      if (text) reply(text());
      else {
        h.clock.advance(DEFER_TTL_MS);
        expect(h.scheduler().pass().fired).toBe(1);
      }
      await drain(runtime);

      expect(runtime.runs[1]!.input.answer).toMatchObject({ callId: "call-1", ...expected });
      expect(runtime.runs[1]!.input.answer?.result).toBeUndefined();
      expect(runtime.runs[1]!.asks).toEqual(["defer"]);
      expect(runtime.harnessEffects).toEqual([]);
      expect(h.store.tx((t) => t.getSession(session))?.pending).toBe("call-2");
    });

    test("asking again under the id of a call that was already answered is refused", async () => {
      const runtime = harness([asks(command("call-1")), asks(command("call-1", "ls"))]);
      await askFirst(runtime);
      reply("/deny no");
      await drain(runtime);

      expect(h.runs()[1]!.error).toContain("call-1");
      expect(requests()).toHaveLength(1);
    });
  });
}
