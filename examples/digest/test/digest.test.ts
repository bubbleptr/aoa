import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime, type RunScript } from "@aoa-dev/conformance";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createHost } from "@aoa-dev/sdk";
import { DAY_MS, DIGEST_JOB, digestAgent, type Issue, type IssueSource } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const START = Date.UTC(2026, 10, 18, 7);
const ANCHOR = Date.UTC(2026, 10, 18, 8);

const issue = (number: number, title: string, labels: string[] = []): Issue => ({
  number,
  title,
  url: `https://github.com/o/r/issues/${number}`,
  state: "open",
  labels,
  updatedAt: START,
  body: "x".repeat(5_000),
});

/** A source that records each `since` it was asked for. */
function source(issues: Issue[]): IssueSource & { asked: number[] } {
  const asked: number[] = [];
  return { asked, updatedSince: async (since) => (asked.push(since), issues) };
}

function setup(scripts: RunScript[], issues: Issue[] = [], store = sqliteStore(":memory:"), clock = new FakeClock(START)) {
  opened.push(store);
  const host = createHost({ store, clock, log: () => {} });
  const runtime = new ScriptedRuntime(scripts);
  const src = source(issues);
  const agent = digestAgent(host, { inbox: "digest", runtime, issues: src, anchor: ANCHOR });
  /** Moves to the next check and runs it, with nothing but `step`. */
  const day = async () => {
    clock.advance(ANCHOR + DAY_MS * runtime.runs.length - clock.now());
    expect(agent.step.scheduler().fired).toBe(1);
    await agent.step.worker();
  };
  return { host, agent, runtime, src, store, clock, day };
}

const check: RunScript = { calls: [{ tool: "recent_issues", callId: "c1" }] };
const alert = (text: string): RunScript => ({
  calls: [
    { tool: "recent_issues", callId: "c1" },
    { tool: "notify", callId: "c2", args: { body: text } },
  ],
});

test("a quiet day: the job reaches the model, the issues come back cut short, and nothing is said", async () => {
  const { host, agent, runtime, day } = setup([check], [issue(1, "Typo in README")]);
  await day();

  const run = runtime.runs[0]!;
  expect(run.input.events[0]!.payload).toEqual({ job: DIGEST_JOB });
  expect(run.input.tools.map((t) => t.name).sort()).toEqual(["notify", "recent_issues"]);
  const listed = run.toolResults[0] as { status: "ok"; output: { issues: { body: string }[] } };
  expect(listed.output.issues[0]!.body).toHaveLength(1_000);
  expect(host.messages()).toEqual([]);
  expect(agent.read.runs()[0]!.end).toEqual({ kind: "silent" });
});

test("a day with something for the user: one message, already sent, with no channel", async () => {
  const { host, day } = setup([alert("#2 Login is broken for everyone: https://github.com/o/r/issues/2")], [issue(2, "Login broken", ["bug"])]);
  await day();
  const [m] = host.messages();
  expect(m).toMatchObject({ agent: "digest", status: "sent" });
  expect(m!.body).toContain("issues/2");
});

test("each check asks for what changed since the previous one started; the first looks back one day", async () => {
  const { src, day, agent } = setup([check, check]);
  await day();
  await day();
  const [first, second] = agent.read.runs();
  expect(src.asked).toEqual([first!.startedAt - DAY_MS, first!.startedAt]);
  expect(second!.startedAt - first!.startedAt).toBe(DAY_MS);
});

test("restarting keeps one daily timer", async () => {
  const store = sqliteStore(":memory:");
  const clock = new FakeClock(START);
  setup([], [], store, clock);
  const again = setup([], [], store, clock);
  expect(again.agent.read.timers()).toHaveLength(1);
});
