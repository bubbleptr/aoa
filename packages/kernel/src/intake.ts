import type { CrashHook } from "./crash.ts";
import type { Clock, Store } from "./ports.ts";
import type { EventId, InboxId, NewEvent, SessionId } from "./types.ts";

export type AppendDeps = { store: Store; clock: Clock; inboxId: InboxId; crash?: CrashHook };

export type AppendResult = { id: EventId; status: "pending" | "dropped"; resume: SessionId | null };

/**
 * The handler's write: durable when it returns, and it never waits on a run (I-EVT-5).
 * A redelivery of an accepted `(source, dedupeKey)` is kept as a `dropped` row for audit.
 * Waking a worker is the caller's job.
 */
export function appendEvent(deps: AppendDeps, e: NewEvent): AppendResult {
  const { store, clock, inboxId } = deps;
  const result = store.tx((t): AppendResult => {
    const id = crypto.randomUUID();
    const thread = e.thread ?? null;
    const status = t.isAccepted(e.source, e.dedupeKey) ? "dropped" : "pending";
    const resume = status === "pending" && thread !== null ? t.sessionForThread(inboxId, thread) : null;
    t.insertEvent({
      id,
      inboxId,
      source: e.source,
      dedupeKey: e.dedupeKey,
      receivedAt: clock.now(),
      payload: e.payload,
      thread,
      resume,
      trusted: e.trusted,
      status,
    });
    return { id, status, resume };
  });
  deps.crash?.("after_append");
  return result;
}
