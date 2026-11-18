import { AwaitingApproval, type OutMsg, type Session } from "@aoa-dev/sdk";
import { type StatusReport, asks, collectStatus, renderStatus, resolveCallId } from "./status.ts";
import type { Agent } from "./wiring.ts";

const nonEmpty = (text: string) => {
  if (text.trim() === "") throw new Error("Nothing to send: the text is empty.");
};

/**
 * With `refuseApproval`, a session that waits on an approval, which the kernel would take this text as answering,
 * refuses it; checked in the append's transaction, so serve cannot pause the session in between.
 */
function appendUserText(agent: Agent, thread: string, text: string, o: { branch?: string; refuseApproval?: boolean } = {}) {
  const event = {
    source: "user_message" as const,
    dedupeKey: `send:${crypto.randomUUID()}`,
    payload: { kind: "send", text, ...(o.branch === undefined ? {} : { branch: o.branch }) },
    thread,
    trusted: true,
  };
  try {
    return agent.hosted.append(event, { refuseWhileAwaitingApproval: o.refuseApproval ?? false });
  } catch (err) {
    if (!(err instanceof AwaitingApproval)) throw err;
    const { pending } = err;
    throw new Error(
      `The task on ${thread} waits for an approval of call ${pending.callId} (${asks(pending.tool, pending.kind, pending.args)}). ` +
        "Answer it with answer once the user has said yes or no; send does not answer approvals.",
    );
  }
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
  agent.records.results.declare(session.id, result);
  // A session that is already closed has nothing left to close; a later reopening must not be closed by this.
  if (session.status === "closed") agent.records.results.markApplied(session.id);
  return session;
}

type Task = { agent: Agent; thread: string; session: Session | null };

/**
 * A task in any agent's inbox named by one of its threads, or a unique prefix of its primary thread or its session
 * id. A task sent but not yet picked up by serve has a thread and no session yet.
 */
function resolveTask(agent: Agent, target: string): Task {
  return agent.host.snapshot(() => {
    for (const a of agent.agents) {
      const exact = a.hosted.read.sessionFor(target);
      if (exact !== null) return { agent: a, session: a.hosted.read.session(exact)!, thread: target };
    }
    const candidates: Task[] = agent.agents.flatMap((a) => {
      const started = a.hosted.read
        .sessions()
        .map((session) => ({ agent: a, session, thread: a.hosted.read.threads(session.id)[0] ?? null }))
        .filter((c): c is Task & { session: Session; thread: string } => c.thread !== null);
      const waiting = [...new Set(a.hosted.read.events().map((e) => e.thread))]
        .filter((thread): thread is string => thread !== null && a.hosted.read.sessionFor(thread) === null)
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

/**
 * Answers a call waiting in any agent's inbox; the answer goes to the inbox that holds it. `via` records where an
 * answer not typed on the command line came from.
 */
export function answer(agent: Agent, prefix: string, verdict: string, text: string | undefined, via?: "mcp"): string {
  if (verdict !== "approve" && verdict !== "deny") throw new Error(`The answer must be approve or deny, not "${verdict}".`);
  const pending = agent.host.snapshot(() => agent.agents.flatMap((a) => a.hosted.read.pending()));
  const callId = resolveCallId(
    pending.map((d) => d.callId),
    prefix,
  );
  const { inboxId } = pending.find((d) => d.callId === callId)!;
  agent.agents
    .find((a) => a.inboxId === inboxId)!
    .hosted.answer(callId, { verdict, ...(text === undefined ? {} : { text }), ...(via === undefined ? {} : { via }) });
  return callId;
}

export async function status(agent: Agent, o: { json: boolean; refresh: boolean }): Promise<string> {
  if (o.refresh) for (const a of agent.agents) await a.refreshPulls();
  const reports = agent.host.snapshot(() => agent.agents.map((a) => collectStatus(a.hosted.read, a.records, a.name, a.statusColumns)));
  const report: StatusReport = {
    agents: agent.agents.map((a) => ({ name: a.name, runtime: a.runtime, permissionOwner: a.permissions })),
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
    const all = agent.host.messages();
    const waiting = new Set(agent.agents.flatMap((a) => a.hosted.read.pending()).map((d) => d.callId));
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
