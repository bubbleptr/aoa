import { describe, expect, test } from "bun:test";
import { DEFAULT_RATE_POLICY, pace, type MsgKind, type OutMsg, type RatePolicy } from "@aoa/kernel";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let seq = 0;
function msg(kind: MsgKind = "message"): OutMsg {
  const id = `m${++seq}`;
  return {
    id,
    inboxId: "inbox-1",
    sessionId: "session-1",
    thread: null,
    kind,
    body: id,
    callId: kind === "approval_request" ? `call-${id}` : null,
    dedupeKey: id,
    createdAt: 0,
    status: "pending",
    attempts: 0,
  };
}

/** Local wall-clock time, so the quiet-period tests hold in any timezone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

describe("rate policy", () => {
  const now = at(16, 12);

  test("the window holds a message until its oldest send leaves the window, then lets one through", () => {
    const sent = [50, 40, 30, 20, 10, 5].map((m) => now - m * MINUTE);
    const m = msg();
    expect(pace([m], sent, now, DEFAULT_RATE_POLICY)).toEqual({ send: [], nextCheckAt: now + 10 * MINUTE });
    expect(pace([m], sent, now + 10 * MINUTE, DEFAULT_RATE_POLICY).send).toEqual([m]);
  });

  test("messages keep the minimum interval from the last send and from each other", () => {
    const [a, b] = [msg(), msg()];
    expect(pace([a, b], [now - 29_999], now, DEFAULT_RATE_POLICY)).toEqual({ send: [], nextCheckAt: now + 1 });
    expect(pace([a, b], [now - 30_000], now, DEFAULT_RATE_POLICY)).toEqual({ send: [a], nextCheckAt: now + 30_000 });
  });

  test("without a minimum interval, only what is left of the window goes out", () => {
    const policy: RatePolicy = { maxMsgs: 3, windowMs: HOUR, minIntervalMs: 0 };
    const batch = [msg(), msg(), msg()];
    expect(pace(batch, [now - 59 * MINUTE], now, policy)).toEqual({ send: batch.slice(0, 2), nextCheckAt: now + MINUTE });
  });

  test("a quiet period that wraps midnight holds messages until it ends", () => {
    const policy: RatePolicy = { ...DEFAULT_RATE_POLICY, quietPeriod: { startMinute: 22 * 60, endMinute: 7 * 60 } };
    const m = msg();
    expect(pace([m], [], at(16, 21, 59), policy).send).toEqual([m]);
    expect(pace([m], [], at(16, 22), policy)).toEqual({ send: [], nextCheckAt: at(17, 7) });
    expect(pace([m], [], at(17, 6, 59), policy)).toEqual({ send: [], nextCheckAt: at(17, 7) });
    expect(pace([m], [], at(17, 7), policy).send).toEqual([m]);
  });

  test("approval requests go out at once even when the window is full and it is quiet time", () => {
    const policy: RatePolicy = { maxMsgs: 1, windowMs: HOUR, minIntervalMs: MINUTE, quietPeriod: { startMinute: 0, endMinute: 24 * 60 } };
    const [m, a1, a2] = [msg(), msg("approval_request"), msg("approval_request")];
    const plan = pace([m, a1, a2], [now - 1], now, policy);
    expect(plan.send).toEqual([a1, a2]);
    expect(plan.nextCheckAt).not.toBeNull();
  });
});
