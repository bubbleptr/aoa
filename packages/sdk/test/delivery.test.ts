import { afterEach, expect, test } from "bun:test";
import { FakeChannel, FakeClock, ScriptedRuntime } from "@aoa/conformance";
import type { Channel } from "@aoa/kernel";
import { sqliteStore } from "@aoa/store-sqlite";
import { createHost } from "../src/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const say = (text: string, thread: string) => ({ source: "user_message" as const, dedupeKey: text, payload: { text }, thread, trusted: true });

test("without a channel a message is sent when it is written, so the next run knows what the user was told", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const runtime = new ScriptedRuntime([{ calls: [{ tool: "notify", callId: "n1", args: { body: "the build is red" } }] }, {}]);
  const agent = host.agent({ name: "a", inbox: "in", runtime, debounceMs: 0 });

  agent.append(say("check the build", "t1"));
  await agent.step.worker();
  agent.append(say("anything else?", "t2"));
  await agent.step.worker();

  const [message] = host.messages();
  expect(message).toMatchObject({ status: "sent", body: "the build is red" });
  expect(message!.sentAt).toBe(message!.createdAt);
  expect(runtime.runs[1]!.input.resident).toContain("the build is red");
});

test("a channel without poll is never polled, and one with poll is polled every 60 seconds by default", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const host = createHost({ store, clock, log: () => {} });
  const polled = new FakeChannel();
  const pushOnly: Channel = { deliver: async () => {} };
  host.agent({ name: "a", inbox: "in-a", runtime: new ScriptedRuntime(), channel: polled });
  host.agent({ name: "b", inbox: "in-b", runtime: new ScriptedRuntime(), channel: pushOnly });
  host.start();
  await Bun.sleep(0);
  expect(polled.polls).toHaveLength(1);
  clock.advance(59_999);
  await Bun.sleep(0);
  expect(polled.polls).toHaveLength(1);
  clock.advance(1);
  await Bun.sleep(0);
  expect(polled.polls).toHaveLength(2);
  await host.stop();
});
