import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, HarnessRunInput, Tool } from "@aoa/kernel";
import { Connection, spawnAppServer } from "../src/connection.ts";
import { codexRuntime } from "../src/index.ts";

/**
 * Against the real `codex app-server`, with the user's own Codex login and configuration, so it calls a model.
 * Run it by hand: AOA_CODEX_SMOKE=1 bun test packages/runtimes/codex/test/smoke.test.ts
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
      attempts: 0,
      nextAttemptAt: 0,
      run: null,
    });
    const input = (text: string, ref: string | null): HarnessRunInput => ({
      runId: crypto.randomUUID(),
      session: { id: "smoke", resumed: ref !== null, ref, workdir: dir },
      events: [event(text)],
      resident: "",
      tools: [notify],
      ask: async () => "allow",
      signal: new AbortController().signal,
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

test.skipIf(process.env.AOA_CODEX_SMOKE !== "1")(
  "aoa's Codex child starts with no MCP tools, hooks or plugins from the user's Codex config",
  async () => {
    const proc = await spawnAppServer(tmpdir());
    const conn = new Connection(proc, { request: async () => null, notification: () => {}, replied: () => {} });
    try {
      await conn.request("initialize", { clientInfo: { name: "aoa-smoke", version: "0" }, capabilities: { experimentalApi: true } });
      conn.notify("initialized", undefined);
      const mcp = (await conn.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly" })) as { data: { tools: object }[] };
      expect(mcp.data.flatMap((s) => Object.keys(s.tools))).toEqual([]);
      const hooks = (await conn.request("hooks/list", {})) as { data: { hooks: unknown[] }[] };
      expect(hooks.data.flatMap((h) => h.hooks)).toEqual([]);
      const plugins = (await conn.request("plugin/installed", {})) as { marketplaces: unknown[] };
      expect(plugins.marketplaces).toEqual([]);
    } finally {
      proc.kill();
    }
  },
  60_000,
);
