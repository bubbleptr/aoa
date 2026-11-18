import { afterEach, expect, test } from "bun:test";
import { FakeClock, ScriptedRuntime, type RunScript } from "@aoa-dev/conformance";
import { sqliteStore } from "../src/index.ts";
import { type AgentMessage, MAX_HOPS, createHost, sendToTool } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const send = (callId: string, args: Record<string, unknown>): RunScript => ({ calls: [{ tool: "send_to", callId, args }] });

function pair(scripts: { a?: RunScript[]; b?: RunScript[] } = {}, o: Parameters<typeof sendToTool>[1] = {}) {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const host = createHost({ store, clock: new FakeClock(), log: () => {} });
  const tool = sendToTool(host, o);
  const ra = new ScriptedRuntime(scripts.a ?? []);
  const rb = new ScriptedRuntime(scripts.b ?? []);
  const a = host.agent({ name: "a", description: "implements", inbox: "in-a", runtime: ra, tools: [tool], debounceMs: 0 });
  // Registered after the tool was made: the tool still lists it.
  const b = host.agent({ name: "b", description: "reviews", inbox: "in-b", runtime: rb, tools: [tool], debounceMs: 0 });
  const user = (text: string, key = text) => a.append({ source: "user_message", dedupeKey: key, payload: { text }, thread: "user-thread", trusted: true });
  return { host, a, b, ra, rb, user, tool };
}

const messages = (agent: { read: { events(): { source: string; payload: unknown; thread: string | null; trusted: boolean }[] } }) =>
  agent.read.events().filter((e) => e.source === "agent_message");

test("the tool lists the agents by name and description, also one registered after it", async () => {
  const { ra, user, a } = pair();
  user("hi");
  await a.step.worker();
  const offered = ra.runs[0]!.input.tools.find((t) => t.name === "send_to")!;
  expect(offered.description).toContain("b (reviews)");
  expect(offered.description).toContain("a (implements)");
});

test("a message opens a new thread in the target, carries the sender's thread for the reply, and is as trusted as the sender", async () => {
  const { a, b, user } = pair({ a: [send("c1", { agent: "b", text: "please review" })] });
  user("hand it over");
  await a.step.worker();

  const [m] = messages(b);
  expect(m!.thread).toMatch(/^agent:b\//);
  expect(m!.trusted).toBe(true);
  expect(m!.payload as AgentMessage).toEqual({ from: "a", text: "please review", hop: 1, replyThread: "user-thread" });
});

test("two messages to the same agent open two threads; the target's reply goes back to the sender's thread", async () => {
  const { a, b, user } = pair({
    a: [{ calls: [{ tool: "send_to", callId: "c1", args: { agent: "b", text: "one" } }, { tool: "send_to", callId: "c2", args: { agent: "b", text: "two" } }] }],
    b: [send("r1", { agent: "a", text: "done" })],
  });
  user("go");
  await a.step.worker();
  const threads = messages(b).map((m) => m.thread);
  expect(new Set(threads).size).toBe(2);

  await b.step.worker();
  const [reply] = messages(a);
  expect(reply!.thread).toBe("user-thread");
  expect((reply!.payload as AgentMessage).hop).toBe(2);
});

test(`the chain stops at ${MAX_HOPS} messages`, async () => {
  const ping = (n: number) => send(`c${n}`, { agent: "b", text: `ping ${n}` });
  const pong = (n: number) => send(`r${n}`, { agent: "a", text: `pong ${n}` });
  const { a, b, ra, user } = pair({ a: [ping(1), ping(3), ping(5)], b: [pong(2), pong(4)] });
  user("start");
  for (let i = 0; i < 3; i++) {
    await a.step.worker();
    await b.step.worker();
  }
  expect(messages(b)).toHaveLength(2);
  expect(messages(a)).toHaveLength(2);
  expect(ra.runs[2]!.toolResults[0]).toMatchObject({ status: "error" });
});

test("extra parameters go into the payload once check passes; a failed check appends nothing", async () => {
  const checked: unknown[] = [];
  const { a, b, ra, user } = pair(
    { a: [send("c1", { agent: "b", text: "look", branch: "missing" }), send("c2", { agent: "b", text: "look", branch: "main" })] },
    {
      params: { branch: { type: "string", description: "The branch to review." } },
      async check(target, args) {
        checked.push([target.name, args.branch]);
        if (args.branch === "missing") throw new Error("There is no branch missing.");
      },
    },
  );
  user("first");
  await a.step.worker();
  expect(ra.runs[0]!.toolResults[0]).toMatchObject({ status: "error" });
  expect(messages(b)).toEqual([]);

  user("second");
  await a.step.worker();
  expect(messages(b).map((m) => (m.payload as AgentMessage).branch)).toEqual(["main"]);
  expect(checked).toEqual([
    ["b", "missing"],
    ["b", "main"],
  ]);
});

test("an unknown target names the others", async () => {
  const { a, ra, user } = pair({ a: [send("c1", { agent: "nobody", text: "hi" })] });
  user("go");
  await a.step.worker();
  expect(ra.runs[0]!.toolResults[0]).toMatchObject({ status: "error", error: expect.stringContaining("b") });
});
