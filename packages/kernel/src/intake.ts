import type { CrashHook } from "./crash.ts";
import { answerEvent, asAnswer } from "./deferred.ts";
import type { Clock, Store, Tx } from "./ports.ts";
import type { CallId, EventId, InboxId, NewEvent, SessionId } from "./types.ts";

export type AppendDeps = { store: Store; clock: Clock; inboxId: InboxId; crash?: CrashHook };

export type AppendResult = { id: EventId; status: "pending" | "dropped"; resume: SessionId | null };

/**
 * The handler's write: durable when it returns, and it never waits on a run (I-EVT-5).
 * A redelivery of an accepted `(source, dedupeKey)` is kept as a `dropped` row for audit.
 * Waking a worker is the caller's job.
 */
export function appendEvent(deps: AppendDeps, e: NewEvent): AppendResult {
  const { store, clock, inboxId } = deps;
  const result = store.tx((t) => appendInTx(t, inboxId, clock.now(), e));
  deps.crash?.("after_append");
  return result;
}

/**
 * Appends inside a caller's transaction. Without an explicit `resume`, the event's `thread`
 * decides which session it continues. An answer to a deferred call is stored as `approval_answer`
 * under one key per call, so only the first answer counts (I-PRM-5), whether it is a reply or the expiry.
 */
export function appendInTx(t: Tx, inboxId: InboxId, now: number, incoming: NewEvent, resumeHint?: SessionId): AppendResult {
  const seen = t.isAccepted(inboxId, incoming.source, incoming.dedupeKey);
  const answer = seen ? null : asAnswer(t, inboxId, incoming, resumeHint);
  // The answer is stored under its own key; the incoming key is kept too, so a redelivered reply cannot answer a later call.
  if (answer) t.consumeKey(inboxId, incoming.source, incoming.dedupeKey);
  const e = answer?.event ?? incoming;
  const resume = answer?.resume ?? resumeHint;
  const id = crypto.randomUUID();
  const thread = e.thread ?? null;
  const status = (answer ? t.isAccepted(inboxId, e.source, e.dedupeKey) : seen) ? "dropped" : "pending";
  const target =
    status === "dropped" ? null : (resume ?? (thread !== null ? t.sessionForThread(inboxId, thread) : null));
  t.insertEvent({
    id,
    inboxId,
    source: e.source,
    dedupeKey: e.dedupeKey,
    receivedAt: now,
    payload: e.payload,
    thread,
    resume: target,
    trusted: e.trusted,
    status,
  });
  return { id, status, resume: target };
}

/** The CLI's way to answer (`aoa answer`): the same event a reply on the thread becomes. */
export function answerDeferred(
  store: Store,
  clock: Clock,
  inboxId: InboxId,
  callId: CallId,
  verdict: "approve" | "deny",
  text?: string,
): AppendResult {
  return store.tx((t) => {
    const pending = t.getDeferred(callId);
    if (!pending) throw new Error(`no deferred call ${callId} is waiting for an answer`);
    const answer = answerEvent({ callId, verdict, ...(text === undefined ? {} : { text }) }, null);
    return appendInTx(t, inboxId, clock.now(), answer, pending.sessionId);
  });
}
