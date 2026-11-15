import type { Store } from "./ports.ts";
import type { SessionId } from "./types.ts";

/** Ends a session: its timers are cancelled. A later event on one of its threads reopens it. */
export function closeSession(store: Store, sessionId: SessionId): void {
  store.tx((t) => {
    t.setSessionStatus(sessionId, "closed");
    t.cancelTimersForSession(sessionId);
  });
}
