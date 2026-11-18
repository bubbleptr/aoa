import type { MsgKind, MsgStatus, OutMsg } from "./channel.ts";
import type { JournalRecord, OutboxRow, Store } from "./ports.ts";
import { RESIDENT_RECENT_MESSAGES } from "./resident.ts";
import type { DecisionRecord, Event, EventStatus, InboxId, PendingCall, RunRecord, Session, SessionId, Timer } from "./types.ts";

/**
 * A read-only view of one inbox (design §15): what an agent's caller, a tool in flight, and the classifier judging one
 * of its calls may look at. Lists are oldest first; `since` and `limit` page forward, `limit` keeping the first ones
 * after `since`.
 */
export type Reader = {
  /** One session of this inbox, or null if no session of this inbox has that id. */
  session(id: SessionId): Session | null;
  sessions(): Session[];
  /** The session's threads, the primary one (where its messages go) first. */
  threads(session: SessionId): string[];
  sessionFor(thread: string): SessionId | null;
  /** `since` is a receive time, inclusive. */
  events(o?: { sessionId?: SessionId; thread?: string; status?: EventStatus; since?: number; limit?: number }): Event[];
  /** The calls waiting for the user, approvals and questions alike. */
  pending(): PendingCall[];
  timers(): Timer[];
  /** `since` is a start time, inclusive. */
  runs(o?: { sessionId?: SessionId; since?: number; limit?: number }): RunRecord[];
  /** Messages of this inbox in the order queued, optionally filtered. */
  outbox(o?: { sessionId?: SessionId; status?: MsgStatus; kind?: MsgKind; limit?: number }): OutboxRow[];
  /** Latest delivered `message` rows, oldest first: the same slice a run gets as "Already told the user". */
  recentSent(limit?: number): OutMsg[];
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
    session: (id) => {
      const s = store.tx((t) => t.getSession(id));
      return s !== null && s.inboxId === inboxId ? s : null;
    },
    sessions: () => store.tx((t) => t.listSessions(inboxId)),
    threads: (session) => {
      own(session);
      return store.tx((t) => t.listThreads(session));
    },
    sessionFor: (thread) => store.tx((t) => t.sessionForThread(inboxId, thread)),
    events: (o = {}) => {
      const filter = {
        ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }),
        ...(o.thread === undefined ? {} : { thread: o.thread }),
        ...(o.status === undefined ? {} : { status: o.status }),
      };
      const rows = store
        .tx((t) => t.listEvents(inboxId, filter))
        .filter(
          (e) =>
            (o.sessionId === undefined || e.resume === o.sessionId) &&
            (o.thread === undefined || e.thread === o.thread) &&
            (o.status === undefined || e.status === o.status),
        );
      return page(rows, (e) => e.receivedAt, o);
    },
    pending: () => store.tx((t) => t.listDeferred(inboxId)),
    timers: () => store.tx((t) => t.listTimers(inboxId)),
    runs: (o = {}) => {
      const filter = o.sessionId === undefined ? undefined : { sessionId: o.sessionId };
      const rows = store
        .tx((t) => t.listRuns(inboxId, filter))
        .filter((r) => o.sessionId === undefined || r.sessionId === o.sessionId);
      return page(rows, (r) => r.startedAt, o);
    },
    outbox: (o = {}) => {
      const rows = store
        .tx((t) => t.listOutbox(inboxId))
        .filter(
          (m) =>
            (o.sessionId === undefined || m.sessionId === o.sessionId) &&
            (o.status === undefined || m.status === o.status) &&
            (o.kind === undefined || m.kind === o.kind),
        );
      return o.limit === undefined ? rows : rows.slice(0, o.limit);
    },
    recentSent: (limit = RESIDENT_RECENT_MESSAGES) => store.tx((t) => t.listRecentSent(inboxId, limit)),
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

/**
 * What the policy's classifier may read (design §6.2): the inbox as `Reader` shows it, except that of earlier calls it
 * gets only which tool was called with what arguments. A result is text a tool fetched from outside, which is exactly
 * what must not steer the judgment of the next call.
 */
export type PolicyReader = Omit<Reader, "journal"> & {
  /** The session's calls the policy allowed, in order: tool and arguments, no result. */
  calls(session: SessionId): { callId: string; tool: string; args: unknown }[];
};

export function policyReader(store: Store, inboxId: InboxId): PolicyReader {
  const { journal, ...rest } = reader(store, inboxId);
  return { ...rest, calls: (session) => journal(session).map(({ callId, tool, args }) => ({ callId, tool, args })) };
}
