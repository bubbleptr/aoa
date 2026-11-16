import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, RunInput, Tool } from "@aoa/kernel";
import { codexRuntime } from "../src/index.ts";

/**
 * Against the real `codex app-server`, with the user's own Codex login and configuration, so it calls a model.
 * Run it by hand: AOA_CODEX_SMOKE=1 bun test packages/runtime-codex/test/smoke.test.ts
 */
test.skipIf(process.env.AOA_CODEX_SMOKE !== "1")(
  "a real Codex thread calls aoa's dynamic tool, and a second process resumes the thread with the tool still offered",
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aoa-codex-smoke-")));
    Bun.spawnSync(["git", "init", "-q", dir]);
    const calls: unknown[] = [];
    const notify: Tool = {
      name: "notify",
      description: "Send the user a message.",
      schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
      async invoke(_callId, args) {
        calls.push(args);
        return { status: "ok", output: "sent" };
      },
    };
    const event = (text: string): Event => ({
      id: crypto.randomUUID(),
      inboxId: "smoke",
      source: "user_message",
      dedupeKey: crypto.randomUUID(),
      receivedAt: Date.now(),
      payload: { text },
      thread: null,
      resume: null,
      trusted: true,
      status: "in_run",
      leaseUntil: null,
      attempts: 1,
      nextAttemptAt: 0,
      run: null,
    });
    const input = (text: string, ref: string | null): RunInput => ({
      runId: crypto.randomUUID(),
      session: { id: "smoke", resumed: ref !== null, ref, workdir: dir },
      events: [event(text)],
      resident: "",
      tools: [notify],
      ask: async () => "allow",
    });
    const runtime = codexRuntime({ developerInstructions: "You are a test agent. Do exactly what the user asks.", cwd: dir });
    try {
      const first = await runtime.run(input('Call the notify tool once with body "one", then stop.', null));
      expect(first.end).toEqual({ kind: "silent" });
      expect(first.sessionRef).toBeString();
      const second = await runtime.run(input('Call the notify tool once with body "two", then stop.', first.sessionRef!));
      expect(second.sessionRef).toBe(first.sessionRef);
      expect(calls).toEqual([{ body: "one" }, { body: "two" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
