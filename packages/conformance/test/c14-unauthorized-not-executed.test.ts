import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultRules, type PolicyConfig } from "@aoa/kernel";
import { Harness, ScriptedRuntime, countingTool, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`C14 an unauthorized call is not executed [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("a high-risk call is deferred: not executed, the session pauses, one approval request goes out, the run ends deferred", async () => {
      const deploy = countingTool("deploy");
      h.append({ thread: "github:o/r#1" });
      // The runtime keeps going after the deferral; the kernel still records the run as deferred.
      const runtime = new ScriptedRuntime([{ calls: [{ tool: "deploy", callId: "call-1", args: { env: "prod" } }] }]);
      await h.worker({ runtime, tools: [deploy], policy: { risk: {} } }).drain();

      const session = runtime.runs[0]!.input.session.id;
      expect(deploy.effects).toEqual([]);
      expect(runtime.runs[0]!.toolResults).toEqual([{ status: "deferred" }]);
      expect(h.runs().map((r) => r.end)).toEqual([{ kind: "deferred", callId: "call-1" }]);
      expect(h.store.tx((t) => t.getSession(session))).toMatchObject({ status: "paused", pending: "call-1" });
      expect(h.store.tx((t) => t.getDeferred("call-1"))).toMatchObject({
        sessionId: session,
        tool: "deploy",
        args: { env: "prod" },
        kind: "approval",
        expiresAt: h.clock.now() + 24 * 60 * 60_000,
      });
      const [request] = h.outbox();
      expect(h.outbox()).toHaveLength(1);
      expect(request).toMatchObject({ kind: "approval_request", callId: "call-1", dedupeKey: "approval:call-1", thread: "github:o/r#1" });
      expect(request!.body).toContain("deploy");
      expect(request!.body).toContain('"env": "prod"');
    });

    test("a blocked call is not executed; the run is told why and goes on to another call", async () => {
      const bash = countingTool("bash");
      const policy: PolicyConfig = { risk: { bash: "low" }, rules: defaultRules };
      h.append();
      const runtime = new ScriptedRuntime([
        {
          calls: [
            { tool: "bash", callId: "call-1", args: { command: "git push --force" } },
            { tool: "bash", callId: "call-2", args: { command: "git push origin feature" } },
          ],
        },
      ]);
      await h.worker({ runtime, tools: [bash], policy }).drain();

      expect(bash.effects).toEqual([{ command: "git push origin feature" }]);
      expect(runtime.runs[0]!.toolResults).toEqual([
        { status: "error", error: expect.stringMatching(/^Blocked by policy: .*no-force-push.*\. Find another way\.$/) },
        { status: "ok", output: { done: 1 } },
      ]);
      expect(h.runs().map((r) => r.end)).toEqual([{ kind: "silent" }]);
    });

    test("while a call is pending, further calls in the run are not executed and create nothing", async () => {
      const deploy = countingTool("deploy");
      const lint = countingTool("lint");
      h.append();
      const runtime = new ScriptedRuntime([
        {
          calls: [
            { tool: "deploy", callId: "call-1" },
            { tool: "deploy", callId: "call-2" },
            { tool: "lint", callId: "call-3" },
          ],
        },
      ]);
      await h.worker({ runtime, tools: [deploy, lint], policy: { risk: { lint: "low" } } }).drain();

      expect(runtime.runs[0]!.toolResults).toEqual([{ status: "deferred" }, { status: "deferred" }, { status: "deferred" }]);
      expect([deploy.effects, lint.effects]).toEqual([[], []]);
      expect(h.outbox()).toHaveLength(1);
      expect(h.store.tx((t) => t.getDeferred("call-2"))).toBeNull();
    });
  });
}
