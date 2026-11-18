import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, countingTool } from "@aoa-dev/conformance";
import type { ToolDef } from "@aoa-dev/kernel";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createHost } from "../src/index.ts";
import { dirTranscripts, loopRuntime, type LoopCompleteInput, type LoopCompleteOutput, type LoopTurn } from "../src/loop/index.ts";
import { RETRY_NOTICE } from "../src/prompt.ts";

const opened: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "aoa-loop-"));
  dirs.push(d);
  return d;
};

const say = (text: string, thread = "t1", key = text) => ({
  source: "user_message" as const,
  dedupeKey: key,
  payload: { text },
  thread,
  trusted: true,
});

describe("loopRuntime (@aoa-dev/sdk/loop)", () => {
  test("runs a multi-turn tool loop, deduplicates repeated provider call ids, streams activity, and delivers final_text", async () => {
    const store = sqliteStore(":memory:");
    opened.push(store);
    const clock = new FakeClock();
    const host = createHost({ store, clock, log: () => {} });
    const seenRequests: (readonly LoopTurn[])[] = [];

    const steps: LoopCompleteOutput[] = [
      { reasoning: "checking a", toolCalls: [{ id: "call_0", name: "lookup", args: { q: "alpha" } }] },
      { toolCalls: [{ id: "call_0", name: "lookup", args: { q: "beta" } }] },
      { text: "Both alpha and beta are green." },
    ];
    let idx = 0;
    const runtime = loopRuntime({
      systemPrompt: "You are an ops helper.",
      complete: async (req) => {
        seenRequests.push([...req.messages]);
        return steps[idx++] ?? { text: "" };
      },
    });

    const queries: string[] = [];
    const lookup: ToolDef = {
      name: "lookup",
      risk: "low",
      description: "looks up status",
      schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      async execute(raw) {
        const { q } = raw as { q: string };
        queries.push(q);
        return { q, ok: true };
      },
    };

    const activities: string[] = [];
    const agent = host.agent({
      name: "ops",
      inbox: "ops",
      runtime,
      tools: [lookup],
      reply: "final_text",
      debounceMs: 0,
    });
    agent.activity((a) => activities.push(a.kind === "tool_start" || a.kind === "tool_end" ? `${a.kind}:${a.callId.split(":").at(-1)}` : `${a.kind}:${a.delta}`));

    agent.append(say("check alpha and beta"));
    await agent.step.worker();

    expect(queries).toEqual(["alpha", "beta"]);
    expect(host.messages().map((m) => m.body)).toEqual(["Both alpha and beta are green."]);
    expect(activities).toEqual([
      "reasoning:checking a",
      "tool_start:call_0",
      "tool_end:call_0",
      "tool_start:call_0#1",
      "tool_end:call_0#1",
      "text:Both alpha and beta are green.",
    ]);
    expect(seenRequests).toHaveLength(3);
  });

  test("stops immediately on a deferred call, persists transcript to disk, and resumes with the answer", async () => {
    const store = sqliteStore(":memory:");
    opened.push(store);
    const clock = new FakeClock();
    const host = createHost({ store, clock, log: () => {} });
    const sessionsDir = tempDir();
    const deploy = countingTool("deploy");

    const seen: LoopCompleteInput[] = [];
    const steps: LoopCompleteOutput[] = [
      { toolCalls: [{ id: "d1", name: "deploy", args: { env: "prod" } }] },
      { text: "Deployed to prod after your approval." },
    ];
    let idx = 0;
    const runtime = loopRuntime({
      systemPrompt: "Deploy helper.",
      transcripts: dirTranscripts(sessionsDir),
      complete: async (req) => {
        seen.push({ ...req, messages: [...req.messages] });
        return steps[idx++]!;
      },
    });

    const agent = host.agent({
      name: "ops",
      inbox: "ops",
      runtime,
      tools: [deploy],
      reply: "final_text",
      approvals: { by: "answer" },
      debounceMs: 0,
    });

    agent.append(say("deploy prod", "t1"));
    await agent.step.worker();

    const [pending] = agent.read.pending();
    expect(pending?.tool).toBe("deploy");
    expect(deploy.effects).toHaveLength(0);
    expect(host.messages().map((m) => m.kind)).toEqual(["approval_request"]);

    agent.answer(pending!.callId, { verdict: "approve" });
    await agent.step.worker();

    expect(deploy.effects).toHaveLength(1);
    expect(seen).toHaveLength(2);
    const lastUser = seen[1]!.messages.findLast((m) => m.role === "user");
    expect(lastUser?.role === "user" && lastUser.content).toContain("approved");
    expect(host.messages().map((m) => [m.kind, m.body])).toEqual([
      ["approval_request", expect.stringContaining("deploy")],
      ["message", "Deployed to prod after your approval."],
    ]);
  });

  test("recovers the on-disk transcript after a failed mid-run step, replays journaled calls without re-executing, and adds RETRY_NOTICE", async () => {
    const store = sqliteStore(":memory:");
    opened.push(store);
    const clock = new FakeClock();
    const host = createHost({ store, clock, log: () => {} });
    const sessionsDir = tempDir();
    const charge = { ...countingTool("charge"), risk: "low" as const };

    let call = 0;
    const seenMessages: (readonly LoopTurn[])[] = [];
    const runtime = loopRuntime({
      systemPrompt: "Billing helper.",
      transcripts: dirTranscripts(sessionsDir),
      complete: async (req) => {
        seenMessages.push([...req.messages]);
        call++;
        if (call === 1) return { toolCalls: [{ id: "ch1", name: "charge", args: { cents: 500 } }] };
        if (call === 2) throw new Error("upstream model 503");
        return { text: "Charged 500 cents once." };
      },
    });

    const agent = host.agent({
      name: "billing",
      inbox: "billing",
      runtime,
      tools: [charge],
      reply: "final_text",
      debounceMs: 0,
    });

    agent.append(say("charge 500", "t1"));
    await agent.step.worker();
    expect(agent.read.runs()[0]!.error).toContain("upstream model 503");
    expect(charge.effects).toHaveLength(1);

    // Advance past first retry delay (30s) and run again.
    clock.advance(30_000);
    await agent.step.worker();

    // Non-idempotent `charge` executed only ONCE across both attempts; the retry saw its recorded result and RETRY_NOTICE.
    expect(charge.effects).toHaveLength(1);
    const retryTurns = seenMessages.at(-1)!;
    const userTurns = retryTurns.filter((m): m is Extract<LoopTurn, { role: "user" }> => m.role === "user");
    expect(userTurns).toHaveLength(2);
    expect(userTurns[0]!.content).not.toContain(RETRY_NOTICE);
    expect(userTurns[1]!.content).toContain(RETRY_NOTICE);
    expect(host.messages().map((m) => m.body)).toEqual(["Charged 500 cents once."]);
  });

  test("aborts cleanly when the run's signal fires and resumes on the next pass", async () => {
    const store = sqliteStore(":memory:");
    opened.push(store);
    const clock = new FakeClock();
    const host = createHost({ store, clock, log: () => {} });
    let startedResolve = () => {};
    const started = new Promise<void>((r) => (startedResolve = r));
    let calls = 0;

    const runtime = loopRuntime({
      systemPrompt: "Slow helper.",
      complete: async ({ signal }) => {
        if (++calls === 1) {
          startedResolve();
          return await new Promise<LoopCompleteOutput>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return { text: "finished on second pass" };
      },
    });

    const agent = host.agent({ name: "slow", inbox: "slow", runtime, reply: "final_text", debounceMs: 0 });
    agent.append(say("think", "t1"));
    const draining = agent.step.worker();
    await started;
    expect(agent.abort(agent.read.sessionFor("t1")!)).toBe(true);
    await draining;

    expect(agent.read.runs().map((r) => r.error)).toEqual(["interrupted: the run was aborted", null]);
    expect(host.messages().map((m) => m.body)).toEqual(["finished on second pass"]);
  });
});
