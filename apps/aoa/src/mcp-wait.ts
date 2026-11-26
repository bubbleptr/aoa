import { randomBytes } from "node:crypto";
import type { ServerContext } from "@modelcontextprotocol/server";

/**
 * The MCP Tasks extension (2026-07-28, `io.modelcontextprotocol/tasks`) on `messages`: with `wait`, a client that
 * declares it gets a task to poll with `tasks/get` instead of a call held open. The task is the wait: it completes with
 * exactly what `messages` returns, and cancelling it only stops waiting. The handle carries the cursor, so a poll after
 * a reconnect still finds the wait; the store is read afresh on every poll.
 */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** How often the client should poll; agents work for minutes, so a few seconds of lag costs nothing. */
export const POLL_INTERVAL_MS = 3_000;

type ClientCapabilities = { extensions?: Record<string, unknown>; elicitation?: Record<string, unknown> };

/** The capabilities this request declares; a 2025-era request has no envelope and declares none. */
function declared(ctx: ServerContext): ClientCapabilities {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  return (envelope?.["io.modelcontextprotocol/clientCapabilities"] as ClientCapabilities | undefined) ?? {};
}

export const declaresTasks = (ctx: ServerContext) => declared(ctx).extensions?.[TASKS_EXTENSION] !== undefined;

/** Form elicitation: a bare `elicitation: {}` means form, and so does one that names `form`. */
export function declaresFormElicitation(ctx: ServerContext): boolean {
  const e = declared(ctx).elicitation;
  return e !== undefined && (Object.keys(e).length === 0 || e.form !== undefined);
}

/** A wait: the cursor it waits after (null for from the start) and when it began. */
export type Wait = { since: string | null; startedAt: number };

const HANDLE = /^wait:([0-9a-f-]*):([0-9a-z]+):[0-9a-f]{8}$/;

export const handleOf = (w: Wait) => `wait:${w.since ?? ""}:${w.startedAt.toString(36)}:${randomBytes(4).toString("hex")}`;

/** The wait behind a handle, or null for anything else. */
export function waitOf(handle: string): Wait | null {
  const m = HANDLE.exec(handle);
  return m ? { since: m[1] === "" ? null : m[1]!, startedAt: parseInt(m[2]!, 36) } : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The fields every task state carries. A wait never expires: like `aoa messages --wait`, it is the caller's to end. */
function base(handle: string, w: Wait, now: number) {
  return { taskId: handle, createdAt: iso(w.startedAt), lastUpdatedAt: iso(now), ttlMs: null, pollIntervalMs: POLL_INTERVAL_MS };
}

/** A teammate's call waiting on the user, as a form asks it: the request text and whether it is a question. */
export type Ask = { callId: string; message: string; question: boolean };

/** One form per waiting call, keyed by its call id. A question takes text; anything else takes approve or deny. */
function inputRequests(asks: Ask[]) {
  return Object.fromEntries(
    asks.map((a) => [
      a.callId,
      {
        method: "elicitation/create" as const,
        params: {
          mode: "form" as const,
          message: a.message,
          requestedSchema: a.question
            ? { type: "object", properties: { answer: { type: "string", title: "Answer" } }, required: ["answer"] }
            : {
                type: "object",
                properties: {
                  decision: { type: "string", title: "Decision", enum: ["approve", "deny"] },
                  reason: { type: "string", title: "Reason (optional)" },
                },
                required: ["decision"],
              },
        },
      },
    ]),
  );
}

type Ended = ReturnType<Waits["end"]>;

/**
 * The waits this connection ended. An ended wait keeps its end, as terminal states must not change; after a
 * reconnect a handle nobody remembers is read afresh from the store.
 */
export class Waits {
  private readonly ends = new Map<string, Ended>();

  /** The `tools/call` reply that starts a wait. */
  start(w: Wait) {
    return { resultType: "task" as const, ...base(handleOf(w), w, w.startedAt), status: "working" as const };
  }

  /**
   * `tasks/get`: `input_required` while a call can go to the user as a form (`asks`), `completed` with `result` once
   * something new needs the caller, `working` until then.
   */
  state(handle: string, w: Wait, now: number, look: { settled: boolean; asks: Ask[]; result: () => Record<string, unknown> }) {
    const ended = this.ends.get(handle);
    if (ended) return ended;
    if (look.asks.length > 0) return { ...base(handle, w, now), status: "input_required" as const, inputRequests: inputRequests(look.asks) };
    if (!look.settled) return { ...base(handle, w, now), status: "working" as const };
    return this.end(handle, w, now, { status: "completed", result: look.result() });
  }

  /** `tasks/cancel`: the wait ends as cancelled unless it already ended. */
  cancel(handle: string, w: Wait, now: number): void {
    if (!this.ends.has(handle)) this.end(handle, w, now, { status: "cancelled" });
  }

  private end(handle: string, w: Wait, now: number, how: { status: "completed"; result: Record<string, unknown> } | { status: "cancelled" }) {
    const ended = { ...base(handle, w, now), ...how };
    this.ends.set(handle, ended);
    return ended;
  }
}
