import { answerDeferred, appendEvent } from "@aoa/kernel";
import { collectStatus, renderStatus, resolveCallId } from "./status.ts";
import type { Agent } from "./wiring.ts";

const TITLE_LIMIT = 80;

/** Opens a GitHub issue for the task and appends the user's message on its thread. Returns the thread. */
export async function send(agent: Agent, text: string): Promise<string> {
  if (text.trim() === "") throw new Error("Nothing to send: the text is empty.");
  const title = text.trim().split("\n")[0]!.trim().slice(0, TITLE_LIMIT);
  const thread = await agent.channel.openThread(title, text);
  appendEvent(
    { store: agent.store, clock: agent.clock, inboxId: agent.inboxId },
    { source: "user_message", dedupeKey: `send:${crypto.randomUUID()}`, payload: { kind: "send", text }, thread, trusted: true },
  );
  return thread;
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
  const report = collectStatus(agent.store, agent.inboxId);
  return o.json ? JSON.stringify(report, null, 2) : renderStatus(report);
}
