import type { CallId, InboxId, SessionId, ToolDef } from "./types.ts";
import type { Store, Tx } from "./ports.ts";

/**
 * Drops an unanswered deferred call and records an error in the journal for non-admit calls so an
 * interrupted run replaying the same call id receives the error instead of re-deferring on spent keys.
 */
export function abandonDeferred(
  t: Tx,
  sessionId: SessionId,
  callId: CallId,
  basis: string,
  error: string,
  at?: number,
): void {
  const d = t.getDeferred(callId);
  if (d && d.kind !== "admit" && !t.getJournal(sessionId, d.callId)) {
    const ts = at ?? d.requestedAt;
    t.recordDecision({ callId: d.callId, sessionId, tool: d.tool, decision: "block", basis, at: ts });
    t.recordIntent({ inboxId: d.inboxId, sessionId, callId: d.callId, tool: d.tool, args: d.args, at: ts });
    t.recordResult(sessionId, d.callId, { status: "error", error }, ts);
  }
  t.deleteDeferred(callId);
  t.cancelApprovalRequest(callId);
  t.setSessionPending(sessionId, null);
}

/**
 * Ends a session: its timers are cancelled, and a call it waits on is dropped unanswered together with
 * its request if that has not gone out yet. A later event on one of its threads reopens it.
 */
export function closeSession(store: Store, sessionId: SessionId): void {
  store.tx((t) => {
    const pending = t.getSession(sessionId)?.pending ?? null;
    if (pending !== null) {
      abandonDeferred(
        t,
        sessionId,
        pending,
        "session closed",
        "The session was closed before this call was answered. The call was not executed.",
      );
    }
    t.setSessionStatus(sessionId, "closed");
    t.cancelTimersForSession(sessionId);
  });
}

export type FollowToolDeps = { store: Store; inboxId: InboxId };

/** `follow`: the agent registers a thread it opened (e.g. its pull request) so events there come back to it. */
export function followTools({ store, inboxId }: FollowToolDeps): ToolDef[] {
  const follow: ToolDef = {
    name: "follow",
    risk: "low",
    description:
      "Follow another thread for this task, e.g. the pull request you opened: later comments there come back to " +
      "this session. Pass the thread key a tool returned, such as github:owner/repo#12.",
    schema: {
      type: "object",
      properties: { thread: { type: "string", description: "The thread key to follow." } },
      required: ["thread"],
      additionalProperties: false,
    },
    idempotent: true,
    async execute(raw, ctx) {
      const { thread } = raw as { thread: unknown };
      if (typeof thread !== "string" || thread.trim() === "") throw new Error("thread must be a non-empty string");
      store.tx((t) => {
        const owner = t.sessionForThread(inboxId, thread);
        if (owner !== null && owner !== ctx.sessionId) throw new Error(`${thread} belongs to another task`);
        if (owner === null) t.registerThread(inboxId, thread, ctx.sessionId);
      });
      return { thread, following: true };
    },
  };
  return [follow];
}
