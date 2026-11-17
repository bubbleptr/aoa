import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Harness, ScriptedRuntime, countingTool, storeFactories, type RunScript, type ScriptedCall } from "../src/index.ts";

/**
 * The conventions a tier-2 adapter keeps (design §15), played by a scripted harness against the kernel.
 * Each test is named by its convention's number.
 */
const THREAD = "github:o/r#1";
const own = (callId: string, cmd = "make"): ScriptedCall => ({ tool: "command", callId, args: { command: cmd }, harness: true });
const harness = (scripts: RunScript[] = []) => new ScriptedRuntime(scripts, { kind: "harness" });

for (const [name, factory] of storeFactories) {
  describe(`tier-2 adapter conventions [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    const deploy = countingTool("deploy");
    const drain = (runtime: ScriptedRuntime) => h.worker({ runtime, tools: [deploy] }).drain();
    const reply = (text: string) => h.append({ thread: THREAD, payload: { text } });
    const start = () => h.append({ thread: THREAD });
    const sessionOf = (runtime: ScriptedRuntime, run = 0) => runtime.runs[run]!.input.session.id;

    beforeEach(() => deploy.effects.splice(0));

    test("1: every ask goes to the kernel; a deferred one ends the run deferred and the call does not run", async () => {
      const runtime = harness([{ calls: [own("call-1")] }]);
      start();
      await drain(runtime);

      expect(runtime.runs[0]!.asks).toEqual(["defer"]);
      expect(runtime.harnessEffects).toEqual([]);
      expect(h.runs()[0]!.end).toEqual({ kind: "deferred", callId: "call-1" });
    });

    test("2: an approved ask comes back as the answer, and the same call is then allowed", async () => {
      const runtime = harness([{ calls: [own("call-1")] }, { calls: [own("call-1-again")] }]);
      start();
      await drain(runtime);
      reply("/approve");
      await drain(runtime);

      expect(runtime.runs[1]!.input.answer).toMatchObject({ callId: "call-1", verdict: "approve", result: { status: "ok" } });
      expect(runtime.runs[1]!.asks).toEqual(["allow"]);
      expect(runtime.harnessEffects).toEqual([{ tool: "command", args: { command: "make" } }]);
    });

    test("2: an approved call to one of input.tools has run already; the answer carries its result", async () => {
      const runtime = harness([{ calls: [{ tool: "deploy", callId: "call-1", args: { env: "prod" } }] }]);
      start();
      await drain(runtime);
      reply("/approve");
      await drain(runtime);

      expect(deploy.effects).toEqual([{ env: "prod" }]);
      expect(runtime.runs[1]!.input.answer).toMatchObject({ callId: "call-1", tool: "deploy", result: { status: "ok", output: { done: 1 } } });
    });

    test("3: input.tools reach the harness and go through invoke; a deferred result ends the run deferred", async () => {
      const runtime = harness([{ calls: [{ tool: "deploy", callId: "call-1" }] }]);
      start();
      await drain(runtime);

      expect(runtime.runs[0]!.input.tools.map((t) => t.name)).toContain("deploy");
      expect(runtime.runs[0]!.toolResults).toEqual([{ status: "deferred" }]);
      expect(deploy.effects).toEqual([]);
      expect(h.runs()[0]!.end).toEqual({ kind: "deferred", callId: "call-1" });
    });

    test("4: an id that was answered is not asked about again", async () => {
      const runtime = harness([{ calls: [own("call-1")] }, { calls: [own("call-1", "ls")] }]);
      start();
      await drain(runtime);
      reply("/deny no");
      await drain(runtime);

      expect(h.runs()[1]!.error).toContain("call-1");
    });

    test("5: the harness's own session id comes back as session.ref on the next run", async () => {
      const runtime = harness([{ sessionRef: "thread-abc" }, {}]);
      start();
      await drain(runtime);
      h.append({ thread: THREAD, dedupeKey: "second" });
      await drain(runtime);

      expect(runtime.runs[0]!.input.session.ref).toBeNull();
      expect(runtime.runs[1]!.input.session).toMatchObject({ id: sessionOf(runtime), resumed: true, ref: "thread-abc" });
    });

    test("6: on stop the signal fires, the harness ends the run, and the events wait for the next start", async () => {
      const runtime = harness([{ hang: true }]);
      const { id } = start();
      const worker = h.worker({ runtime });
      const draining = worker.drain();
      await runtime.started(1);
      worker.stop();
      await draining;

      expect(runtime.runs[0]!.input.signal.aborted).toBe(true);
      expect(h.store.tx((t) => t.getEvent(id))?.status).toBe("pending");
    });
  });
}
