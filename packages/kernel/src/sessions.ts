import type { Store } from "./ports.ts";
import type { SessionId } from "./types.ts";

/**
 * Ends a session: its timers are cancelled and a call it waits on is dropped unanswered.
 * A later event on one of its threads reopens it.
 */
export function closeSession(store: Store, sessionId: SessionId): void {
  store.tx((t) => {
    const pending = t.getSession(sessionId)?.pending ?? null;
    if (pending !== null) {
      t.deleteDeferred(pending);
      t.setSessionPending(sessionId, null);
    }
    t.setSessionStatus(sessionId, "closed");
    t.cancelTimersForSession(sessionId);
  });
}
