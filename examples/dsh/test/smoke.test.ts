import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, HarnessRunInput, Tool, ToolResult } from "@aoa/sdk";
import { type DshSpawn, dshRuntime, spawnDsh } from "../src/index.ts";

/**
 * Against the real `dsh --profile sdk`, with a real key, so it calls a real model. Run it by hand:
 * `AOA_DSH_SMOKE=1 DEEPSEEK_API_KEY=... bun test examples/dsh/test/smoke.test.ts`
 * It answers dsh's own tool list from the session events it streams, and never touches the user's dsh home.
 */
const enabled = process.env.AOA_DSH_SMOKE === "1";

const MODEL = process.env.AOA_DSH_SMOKE_MODEL ?? "deepseek-flash";

type Observed = { tools: string[]; calls: string[] };

/** The real spawn, with dsh's session events on the way past, so the test sees what the model was offered and called. */
function tapping(observed: Observed): { spawn: DshSpawn; launched: () => ReturnType<DshSpawn["spawn"]> } {
  const procs: Awaited<ReturnType<DshSpawn["spawn"]>>[] = [];
  return {
    launched: () => procs.at(-1)!,
    spawn: {
      version: (command) => spawnDsh.version(command),
      spawn: async (launch) => {
        const proc = await spawnDsh.spawn(launch);
        procs.push(proc);
        const lines = (async function* () {
          for await (const line of proc.lines) {
            try {
              const message = JSON.parse(line) as { method?: string; params?: { event?: { type?: string; data?: any } } };
              const event = message.method === "session.event" ? message.params?.event : undefined;
              if (event?.type === "tool/call" && typeof event.data?.name === "string") observed.calls.push(event.data.name);
              if (event?.type === "request/header") {
                observed.tools = (event.data?.header?.tools ?? []).map((t: { name: string }) => t.name);
              }
            } catch {}
            yield line;
          }
        })();
        return { ...proc, lines };
      },
    },
  };
}

function input(o: { dir: string; text: string; ref: string | null; tools: Tool[]; ask: HarnessRunInput["ask"] }): HarnessRunInput {
  const event: Event = {
    id: crypto.randomUUID(),
    inboxId: "smoke",
    source: "user_message",
    dedupeKey: crypto.randomUUID(),
    receivedAt: Date.now(),
    payload: { text: o.text },
    thread: null,
    resume: null,
    trusted: true,
    status: "in_run",
    leaseUntil: null,
    attempts: 0,
    nextAttemptAt: 0,
    run: null,
  };
  return {
    runId: crypto.randomUUID(),
    session: { id: "smoke", resumed: o.ref !== null, ref: o.ref, workdir: o.dir },
    events: [event],
    resident: "",
    tools: o.tools,
    ask: o.ask,
    signal: new AbortController().signal,
  };
}

test.skipIf(!enabled)(
  "a real dsh run calls aoa's notify through the bridge without asking, and is offered only aoa's tools",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aoa-dsh-smoke-")));
    Bun.spawnSync(["git", "init", "-q", root]);
    const calls: unknown[] = [];
    const notify: Tool = {
      name: "notify",
      description: "Send the user a message.",
      schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
      async invoke(_callId, args): Promise<ToolResult> {
        calls.push(args);
        return { status: "ok", output: "sent" };
      },
    };
    const observed: Observed = { tools: [], calls: [] };
    const tap = tapping(observed);
    const started = Date.now();
    // Any dsh approval would end the run deferred: aoa's own tools must not need one.
    const ask = async () => "defer" as const;
    const runtime = () =>
      dshRuntime({
        systemPrompt: "You are a test agent. Do exactly what the user asks and nothing else.",
        model: MODEL,
        apiKey: process.env.DEEPSEEK_API_KEY,
        apiKeyEnv: "DEEPSEEK_API_KEY",
        home: join(root, "dsh-home"),
        cwd: root,
        spawn: tap.spawn,
      });
    try {
      const result = await runtime().run(input({ dir: root, text: 'Call the notify tool once with body "one", then stop.', ref: null, tools: [notify], ask }));

      expect(result.end).toEqual({ kind: "silent" });
      expect(result.sessionRef).toBeString();
      expect(calls).toEqual([{ body: "one" }]);
      expect(observed.calls).toContain("mcp__aoa__notify");
      // aoa's tools are offered next to dsh's own (which are yours to configure), and none of the
      // capabilities aoa's patch turns off is still there.
      expect(observed.tools).toContain("mcp__aoa__notify");
      for (const gone of ["ask_user", "schedule", "subagent", "agent_team", "goal", "workflow", "jobs", "plugin_manager"]) {
        expect(observed.tools.some((name) => name.includes(gone))).toBe(false);
      }
      // Cold start is what the user pays for on every run.
      expect(Date.now() - started).toBeLessThan(120_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  300_000,
);

test.skipIf(!enabled)(
  "a session whose dsh process was killed resumes in a new process and keeps working",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aoa-dsh-smoke-")));
    Bun.spawnSync(["git", "init", "-q", root]);
    const calls: unknown[] = [];
    let hold: Promise<void> | null = null;
    const notify: Tool = {
      name: "notify",
      description: "Send the user a message.",
      schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
      async invoke(_callId, args): Promise<ToolResult> {
        calls.push(args);
        await hold;
        return { status: "ok", output: "sent" };
      },
    };
    const observed: Observed = { tools: [], calls: [] };
    const tap = tapping(observed);
    const runtime = () =>
      dshRuntime({
        systemPrompt: "You are a test agent. Do exactly what the user asks and nothing else.",
        model: MODEL,
        apiKey: process.env.DEEPSEEK_API_KEY,
        apiKeyEnv: "DEEPSEEK_API_KEY",
        home: join(root, "dsh-home"),
        cwd: root,
        spawn: tap.spawn,
      });
    const ask = async () => "defer" as const;
    try {
      const first = await runtime().run(input({ dir: root, text: 'Call the notify tool once with body "one", then stop.', ref: null, tools: [notify], ask }));
      expect(calls).toEqual([{ body: "one" }]);

      // The second run is killed while its tool call is in flight, as a crash would leave it.
      let open = () => {};
      hold = new Promise<void>((resolve) => (open = resolve));
      const second = runtime().run(input({ dir: root, text: 'Call the notify tool once with body "two", then stop.', ref: first.sessionRef!, tools: [notify], ask }));
      const deadline = Date.now() + 120_000;
      while (calls.length < 2 && Date.now() < deadline) await Bun.sleep(50);
      expect(calls.length).toBe(2);
      (await tap.launched()).kill("SIGKILL");
      await expect(second).rejects.toThrow();
      hold = null;
      open();

      const third = await runtime().run(input({ dir: root, text: 'Call the notify tool once with body "three", then stop.', ref: first.sessionRef!, tools: [notify], ask }));
      expect(third.sessionRef).toBe(first.sessionRef!);
      expect(calls).toEqual([{ body: "one" }, { body: "two" }, { body: "three" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  300_000,
);
