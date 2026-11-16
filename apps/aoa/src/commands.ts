import { type Session, answerDeferred, appendEvent } from "@aoa/kernel";
import { collectStatus, renderStatus, resolveCallId } from "./status.ts";
import type { Agent } from "./wiring.ts";

const nonEmpty = (text: string) => {
  if (text.trim() === "") throw new Error("Nothing to send: the text is empty.");
};

const appendUserText = (agent: Agent, thread: string, text: string) =>
  appendEvent(
    { store: agent.store, clock: agent.clock, inboxId: agent.inboxId },
    { source: "user_message", dedupeKey: `send:${crypto.randomUUID()}`, payload: { kind: "send", text }, thread, trusted: true },
  );

/** Opens a thread for a new task (a GitHub issue, or a local thread) and appends the user's message on it. Returns the thread. */
export async function send(agent: Agent, text: string): Promise<string> {
  nonEmpty(text);
  const thread = await agent.openThread(text);
  appendUserText(agent, thread, text);
  return thread;
}

/**
 * Appends the user's message on an existing task's thread, so its session resumes. On a session that waits for an
 * answer, the kernel takes the text as that answer. Returns the thread.
 */
export function sendTo(agent: Agent, target: string, text: string): string {
  nonEmpty(text);
  const { thread } = resolveSession(agent, target);
  appendUserText(agent, thread, text);
  return thread;
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
  const { session } = resolveSession(agent, target);
  agent.store.results.declare(session.id, result, agent.clock.now());
  // A session that is already closed has nothing left to close; a later reopening must not be closed by this.
  if (session.status === "closed") agent.store.results.markApplied(session.id);
  return session;
}

/** A session of this inbox named by one of its threads, or a unique prefix of its primary thread or its id. */
function resolveSession(agent: Agent, target: string): { session: Session; thread: string } {
  return agent.store.tx((t) => {
    const exact = t.sessionForThread(agent.inboxId, target);
    if (exact !== null) return { session: t.getSession(exact)!, thread: target };
    const candidates = t
      .listSessions(agent.inboxId)
      .map((session) => ({ session, thread: t.primaryThread(session.id) }))
      .filter((c): c is { session: Session; thread: string } => c.thread !== null);
    const matches = candidates.filter((c) => c.thread.startsWith(target) || c.session.id.startsWith(target));
    if (matches.length === 1) return matches[0]!;
    const list = (cs: typeof candidates) =>
      cs.length === 0 ? "  none" : cs.map((c) => `  ${c.thread}  (session ${c.session.id.slice(0, 8)})`).join("\n");
    if (matches.length === 0) throw new Error(`No task matches "${target}". Tasks:\n${list(candidates)}`);
    throw new Error(`"${target}" is ambiguous; it matches:\n${list(matches)}`);
  });
}

export function answer(agent: Agent, prefix: string, verdict: string, text: string | undefined): string {
  if (verdict !== "approve" && verdict !== "deny") throw new Error(`The answer must be approve or deny, not "${verdict}".`);
  const pending = agent.store.tx((t) => t.listDeferred(agent.inboxId)).map((d) => d.callId);
  const callId = resolveCallId(pending, prefix);
  answerDeferred(agent.store, agent.clock, agent.inboxId, callId, verdict, text);
  return callId;
}

export async function status(agent: Agent, o: { json: boolean; refresh: boolean }): Promise<string> {
  if (o.refresh) await agent.refreshPulls();
  const report = collectStatus(agent.store, agent.inboxId, agent.statusColumns);
  return o.json ? JSON.stringify(report, null, 2) : renderStatus(report);
}
