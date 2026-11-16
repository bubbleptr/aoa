import { type OutMsg, type Session, type Tx, answerDeferred, appendInTx } from "@aoa/kernel";
import { type StatusReport, asks, collectStatus, renderStatus, resolveCallId } from "./status.ts";
import type { Agent } from "./wiring.ts";

const nonEmpty = (text: string) => {
  if (text.trim() === "") throw new Error("Nothing to send: the text is empty.");
};

const appendUserText = (agent: Agent, thread: string, text: string, o: { branch?: string; refuseApproval?: boolean } = {}) =>
  agent.store.tx((t) => {
    // Checked in the append's transaction, so serve cannot pause the session in between.
    if (o.refuseApproval) refuseApproval(t, agent.inboxId, thread);
    return appendInTx(t, agent.inboxId, agent.clock.now(), {
      source: "user_message",
      dedupeKey: `send:${crypto.randomUUID()}`,
      payload: { kind: "send", text, ...(o.branch === undefined ? {} : { branch: o.branch }) },
      thread,
      trusted: true,
    });
  });

/** Throws when the thread's session waits on an approval, which the kernel would take this text as answering. */
function refuseApproval(t: Tx, inboxId: string, thread: string): void {
  const sessionId = t.sessionForThread(inboxId, thread);
  const session = sessionId === null ? null : t.getSession(sessionId);
  if (!session || session.status !== "paused" || session.pending === null) return;
  const pending = t.getDeferred(session.pending);
  if (!pending || pending.kind === "question") return;
  throw new Error(
    `The task on ${thread} waits for an approval of call ${pending.callId} (${asks(pending.tool, pending.kind, pending.args)}). ` +
      "Answer it with answer once the user has said yes or no; send does not answer approvals.",
  );
}

/** The agent of this config with that name. */
function agentNamed(agent: Agent, name: string): Agent {
  const found = agent.agents.find((a) => a.name === name);
  if (!found) throw new Error(`No agent is named "${name}". Agents: ${agent.agents.map((a) => a.name).join(", ")}.`);
  return found;
}

/**
 * Opens a thread for a new task (a GitHub issue, or a local thread) in the default agent's inbox or the named one's,
 * and appends the user's message on it. A review agent may be given the branch to review. Returns the thread.
 */
export async function send(agent: Agent, text: string, o: { agent?: string; branch?: string } = {}): Promise<string> {
  nonEmpty(text);
  const target = o.agent === undefined ? agent : agentNamed(agent, o.agent);
  if (o.branch !== undefined) {
    if (target.role !== "review") throw new Error(`--branch is only for a review agent; ${target.name} implements.`);
    if ((await target.worktrees.commitOf(o.branch)) === null) throw new Error(`There is no branch ${o.branch} in ${target.paths.repo}.`);
  }
  const thread = await target.openThread(text);
  appendUserText(target, thread, text, o.branch === undefined ? {} : { branch: o.branch });
  return thread;
}

/**
 * Appends the user's message on an existing task's thread, so its session resumes. On a session that waits for an
 * answer, the kernel takes the text as that answer. With `refuseApproval`, a session waiting on an approval (not a
 * question) is refused, so approvals have one path: `answer`. Returns the thread.
 */
export function sendTo(agent: Agent, target: string, text: string, o: { refuseApproval?: boolean } = {}): string {
  nonEmpty(text);
  const task = resolveTask(agent, target);
  appendUserText(task.agent, task.thread, text, o);
  return task.thread;
}

/**
 * Local mode: records how the user says a task's branch ended. Only that: `serve` closes the session and removes
 * its worktree on its next check, in its own process, where it can tell whether a run is using the worktree.
 */
export function close(agent: Agent, target: string, result: string): Session {
  if (agent.mode !== "local") {
    throw new Error("aoa close is for local mode. With GitHub, the pull request decides: merge or close it there.");
  }
  if (result !== "merged" && result !== "discarded") throw new Error(`The result must be merged or discarded, not "${result}".`);
  const { thread, session } = resolveTask(agent, target);
  if (session === null) throw new Error(`The task on ${thread} has not started yet: serve picks it up first.`);
  // One store holds every agent's sessions, so the declaration needs no agent.
  agent.store.results.declare(session.id, result);
  // A session that is already closed has nothing left to close; a later reopening must not be closed by this.
  if (session.status === "closed") agent.store.results.markApplied(session.id);
  return session;
}

type Task = { agent: Agent; thread: string; session: Session | null };

/**
 * A task in any agent's inbox named by one of its threads, or a unique prefix of its primary thread or its session
 * id. A task sent but not yet picked up by serve has a thread and no session yet.
 */
function resolveTask(agent: Agent, target: string): Task {
  return agent.store.tx((t) => {
    for (const a of agent.agents) {
      const exact = t.sessionForThread(a.inboxId, target);
      if (exact !== null) return { agent: a, session: t.getSession(exact)!, thread: target };
    }
    const candidates: Task[] = agent.agents.flatMap((a) => {
      const started = t
        .listSessions(a.inboxId)
        .map((session) => ({ agent: a, session, thread: t.primaryThread(session.id) }))
        .filter((c): c is Task & { session: Session; thread: string } => c.thread !== null);
      const waiting = [...new Set(t.listEvents(a.inboxId).map((e) => e.thread))]
        .filter((thread): thread is string => thread !== null && t.sessionForThread(a.inboxId, thread) === null)
        .map((thread) => ({ agent: a, thread, session: null }));
      return [...started, ...waiting];
    });
    const matches = candidates.filter((c) => c.thread.startsWith(target) || (c.session?.id.startsWith(target) ?? false));
    if (matches.length === 1) return matches[0]!;
    const by = (c: Task) => (agent.agents.length > 1 ? `${c.agent.name}, ` : "");
    const list = (cs: Task[]) =>
      cs.length === 0
        ? "  none"
        : cs.map((c) => `  ${c.thread}  (${by(c)}${c.session ? `session ${c.session.id.slice(0, 8)}` : "not started"})`).join("\n");
    if (matches.length === 0) throw new Error(`No task matches "${target}". Tasks:\n${list(candidates)}`);
    throw new Error(`"${target}" is ambiguous; it matches:\n${list(matches)}`);
  });
}

/** Answers a call waiting in any agent's inbox; the answer goes to the inbox that holds it. */
export function answer(agent: Agent, prefix: string, verdict: string, text: string | undefined): string {
  if (verdict !== "approve" && verdict !== "deny") throw new Error(`The answer must be approve or deny, not "${verdict}".`);
  const pending = agent.store.tx((t) => agent.agents.flatMap((a) => t.listDeferred(a.inboxId)));
  const callId = resolveCallId(
    pending.map((d) => d.callId),
    prefix,
  );
  const { inboxId } = pending.find((d) => d.callId === callId)!;
  answerDeferred(agent.store, agent.clock, inboxId, callId, verdict, text);
  return callId;
}

export async function status(agent: Agent, o: { json: boolean; refresh: boolean }): Promise<string> {
  if (o.refresh) for (const a of agent.agents) await a.refreshPulls();
  const reports = agent.agents.map((a) => collectStatus(a.store, a.name, a.inboxId, a.statusColumns));
  const report: StatusReport = {
    sessions: reports.flatMap((r) => r.sessions),
    pending: reports.flatMap((r) => r.pending),
    dead: reports.flatMap((r) => r.dead),
    failed: reports.flatMap((r) => r.failed),
  };
  return o.json ? JSON.stringify(report, null, 2) : renderStatus(report, { agents: agent.agents.length > 1 });
}

export type Listing = {
  messages: (Pick<OutMsg, "id" | "thread" | "sessionId" | "kind" | "body" | "callId" | "createdAt" | "status"> & {
    agent: string;
    /** For an approval request: whether its call still waits for an answer. */
    pending?: boolean;
  })[];
  /** The id of the last message listed, or the cursor given when there is none: pass it as `--since` next time. */
  cursor: string | null;
};

const WAIT_STEP_MS = 1000;

/**
 * What the agents said after the message `since`, oldest first, read from the outbox rather than from where a
 * channel delivered it. Every agent's messages are merged in the order they were queued, which only ever grows at
 * the end, so a cursor stays valid. A withdrawn approval request is left out. With `waitMs`, waits that long for a
 * first message.
 */
export async function messages(agent: Agent, o: { since: string | null; waitMs: number }): Promise<Listing> {
  const deadline = agent.clock.now() + o.waitMs;
  for (;;) {
    const { all, waiting } = agent.store.tx((t) => {
      const queued = agent.agents.flatMap((a) => {
        const order = agent.store.outboxOrder(a.inboxId);
        return t.listOutbox(a.inboxId).map((m) => ({ ...m, agent: a.name, seq: order.get(m.id)! }));
      });
      return {
        all: queued.sort((x, y) => x.seq - y.seq),
        waiting: new Set(agent.agents.flatMap((a) => t.listDeferred(a.inboxId)).map((d) => d.callId)),
      };
    });
    const at = o.since === null ? -1 : all.findIndex((m) => m.id === o.since);
    if (o.since !== null && at < 0) throw new Error(`No message has the id "${o.since}"; run aoa messages without --since for all of them.`);
    const found = all.slice(at + 1).filter((m) => m.status !== "cancelled");
    if (found.length > 0 || agent.clock.now() >= deadline) {
      return {
        messages: found.map(({ agent, id, thread, sessionId, kind, body, callId, createdAt, status }) => ({
          agent,
          id,
          thread,
          sessionId,
          kind,
          body,
          callId,
          createdAt,
          status,
          ...(kind === "approval_request" && callId !== null ? { pending: waiting.has(callId) } : {}),
        })),
        cursor: all.at(-1)?.id ?? o.since,
      };
    }
    await new Promise<void>((resolve) => agent.clock.setTimer(WAIT_STEP_MS, resolve));
  }
}

/** With `agents`, every message names its agent. */
export function renderMessages(l: Listing, o: { agents: boolean } = { agents: false }): string {
  const blocks = l.messages.map((m) => {
    const lines = [`[${m.id}] ${o.agents ? `${m.agent} · ` : ""}${m.thread ?? "-"} · ${m.kind}`, m.body];
    if (m.pending) {
      lines.push(`Answer with: aoa answer ${m.callId} approve   or   aoa answer ${m.callId} deny <reason>`);
    }
    return lines.join("\n");
  });
  return [...(blocks.length > 0 ? blocks : ["No new messages."]), `cursor: ${l.cursor ?? "-"}`].join("\n\n");
}
