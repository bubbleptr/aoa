import type { JournalRecord, Store } from "./ports.ts";
import type { DecisionRecord, Event, EventStatus, InboxId, PendingCall, RunRecord, Session, SessionId, Timer } from "./types.ts";

/**
 * A read-only view of one inbox (design §15): what an agent's caller, and the classifier judging one of its calls, may
 * look at. Lists are oldest first; `since` and `limit` page forward, `limit` keeping the first ones after `since`.
 */
export type Reader = {
  sessions(): Session[];
  /** The session's threads, the primary one (where its messages go) first. */
  threads(session: SessionId): string[];
  sessionFor(thread: string): SessionId | null;
  /** `since` is a receive time, inclusive. */
  events(o?: { status?: EventStatus; since?: number; limit?: number }): Event[];
  /** The calls waiting for the user, approvals and questions alike. */
  pending(): PendingCall[];
  timers(): Timer[];
  /** `since` is a start time, inclusive. */
  runs(o?: { since?: number; limit?: number }): RunRecord[];
  decisions(session: SessionId): DecisionRecord[];
  journal(session: SessionId): JournalRecord[];
};

const page = <T>(rows: T[], at: (r: T) => number, o: { since?: number; limit?: number }): T[] => {
  const after = o.since === undefined ? rows : rows.filter((r) => at(r) >= o.since!);
  return o.limit === undefined ? after : after.slice(0, o.limit);
};

export function reader(store: Store, inboxId: InboxId): Reader {
  const own = (session: SessionId) => {
    const s = store.tx((t) => t.getSession(session));
    if (s === null || s.inboxId !== inboxId) throw new Error(`No session ${session} in inbox ${inboxId}.`);
  };
  return {
    sessions: () => store.tx((t) => t.listSessions(inboxId)),
    threads: (session) => {
      own(session);
      return store.tx((t) => t.listThreads(session));
    },
    sessionFor: (thread) => store.tx((t) => t.sessionForThread(inboxId, thread)),
    events: (o = {}) =>
      page(
        store.tx((t) => t.listEvents(inboxId)).filter((e) => o.status === undefined || e.status === o.status),
        (e) => e.receivedAt,
        o,
      ),
    pending: () => store.tx((t) => t.listDeferred(inboxId)),
    timers: () => store.tx((t) => t.listTimers(inboxId)),
    runs: (o = {}) => page(store.tx((t) => t.listRuns(inboxId)), (r) => r.startedAt, o),
    decisions: (session) => {
      own(session);
      return store.tx((t) => t.listDecisions(session));
    },
    journal: (session) => {
      own(session);
      return store.tx((t) => t.listJournal(session));
    },
  };
}
