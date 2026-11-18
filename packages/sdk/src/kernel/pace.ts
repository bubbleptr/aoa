import type { OutMsg } from "./channel.ts";

/** How often the agent may speak (spec §7.4, D-OUT-2). `quietPeriod` is in minutes of the local day and may wrap midnight. */
export type RatePolicy = {
  maxMsgs: number;
  windowMs: number;
  minIntervalMs: number;
  quietPeriod?: { startMinute: number; endMinute: number };
};

/** Start quiet: at most 6 messages an hour, 30 seconds apart. */
export const DEFAULT_RATE_POLICY: RatePolicy = { maxMsgs: 6, windowMs: 60 * 60_000, minIntervalMs: 30_000 };

export type PacePlan = {
  send: OutMsg[];
  /** When a held message could go; null if nothing is held. */
  nextCheckAt: number | null;
};

/**
 * Picks which of `pending` (in delivery order) may go now, given when earlier messages went.
 * Approval requests are exempt: a deferred call must not wait on the agent's chattiness.
 * Once one message is held, the later ones are too, so pacing never reorders messages.
 */
export function pace(pending: OutMsg[], recentSent: number[], now: number, policy: RatePolicy): PacePlan {
  const sent = [...recentSent].sort((a, b) => a - b);
  const send: OutMsg[] = [];
  let nextCheckAt: number | null = null;
  for (const m of pending) {
    if (m.kind === "approval_request") {
      send.push(m);
      continue;
    }
    if (nextCheckAt !== null) continue;
    const allowedAt = earliestAllowed(sent, now, policy);
    if (allowedAt > now) {
      nextCheckAt = allowedAt;
      continue;
    }
    send.push(m);
    sent.push(now);
  }
  return { send, nextCheckAt };
}

function earliestAllowed(sent: number[], now: number, p: RatePolicy): number {
  let at = now;
  if (p.quietPeriod && inQuietPeriod(now, p.quietPeriod)) at = Math.max(at, nextLocalMinute(now, p.quietPeriod.endMinute));
  const inWindow = sent.filter((s) => s > now - p.windowMs);
  if (inWindow.length >= p.maxMsgs) at = Math.max(at, inWindow[inWindow.length - p.maxMsgs]! + p.windowMs);
  const last = sent.at(-1);
  if (last !== undefined) at = Math.max(at, last + p.minIntervalMs);
  return at;
}

function inQuietPeriod(now: number, q: { startMinute: number; endMinute: number }): boolean {
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  if (q.startMinute <= q.endMinute) return minute >= q.startMinute && minute < q.endMinute;
  return minute >= q.startMinute || minute < q.endMinute;
}

/** The next instant after `now` at `minuteOfDay` local time. */
function nextLocalMinute(now: number, minuteOfDay: number): number {
  const d = new Date(now);
  d.setHours(0, minuteOfDay, 0, 0);
  if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
    d.setHours(0, minuteOfDay, 0, 0);
  }
  return d.getTime();
}
