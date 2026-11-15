import type { InboxId, SessionId, ToolDef } from "./types.ts";
import type { Store } from "./ports.ts";

/**
 * Ends a session: its timers are cancelled, and a call it waits on is dropped unanswered together with
 * its request if that has not gone out yet. A later event on one of its threads reopens it.
 */
export function closeSession(store: Store, sessionId: SessionId): void {
  store.tx((t) => {
    const pending = t.getSession(sessionId)?.pending ?? null;
    if (pending !== null) {
      t.deleteDeferred(pending);
      t.cancelApprovalRequest(pending);
      t.setSessionPending(sessionId, null);
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
