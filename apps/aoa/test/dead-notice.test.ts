import { expect, test } from "bun:test";
import type { Channel, OutMsg } from "@aoa/sdk";
import { withStatusHint } from "../src/wiring.ts";

const msg = (dedupeKey: string): OutMsg => ({
  id: "m",
  inboxId: "in",
  sessionId: "s",
  thread: null,
  kind: "message",
  body: "This task stopped after repeated failures.",
  callId: null,
  dedupeKey,
  createdAt: 0,
  status: "sending",
  attempts: 0,
});

test("aoa's dead-letter notice ends by pointing at aoa status; other messages go out as written", async () => {
  const out: OutMsg[] = [];
  const channel = withStatusHint({ deliver: async (m) => void out.push(m) } satisfies Channel);
  await channel.deliver(msg("dead:s:e1"));
  await channel.deliver(msg("notify:s:c1"));
  expect(out[0]!.body.endsWith("\n\nRun `aoa status` for the details.")).toBe(true);
  expect(out[1]!.body).toBe("This task stopped after repeated failures.");
});
