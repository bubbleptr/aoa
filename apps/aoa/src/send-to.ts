import { type Clock, type Store, type ToolDef, appendEvent } from "@aoa/kernel";
import type { Role } from "./config.ts";
import type { Agent } from "./wiring.ts";

/** How many agent messages one chain may carry; the next one is refused, so two agents cannot talk forever. */
export const MAX_HOPS = 4;

/** The payload of an `agent_message` event. */
export type AgentMessage = {
  from: string;
  text: string;
  /** For a review agent: the branch to review. */
  branch?: string;
  /** 1 for a message sent from a task the user gave; one more than the message it answers otherwise. */
  hop: number;
  /** The sender's thread, where a reply resumes the sender's session. */
  replyThread?: string;
};

const asMessage = (payload: unknown) => payload as AgentMessage;

/**
 * `send_to`: appends a message to another agent's inbox and wakes it. The message is as trusted as the sending
 * session: one that has only taken the user's word and the user's repository passes nothing from anyone else, while a
 * tainted one passes its taint on (design §12). A reply goes back to the thread the sender's session came from.
 */
export function sendToTool(o: {
  store: Store;
  clock: Clock;
  from: string;
  inboxId: string;
  /** Every agent of the config, for the description; known before any of them is assembled. */
  roster: { name: string; role: Role }[];
  /** The assembled agents, looked up when the tool runs. */
  agents: () => Agent[];
}): ToolDef {
  const others = () => o.agents().filter((a) => a.name !== o.from);
  return {
    name: "send_to",
    description:
      "Send a message to another agent working on this repository; it arrives as an event in that agent's inbox. " +
      `The other agents: ${o.roster
        .filter((a) => a.name !== o.from)
        .map((a) => `${a.name} (${a.role})`)
        .join(", ")}. ` +
      "For a review agent, set branch to the branch it should review. A reply resumes this task.",
    schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's name." },
        text: { type: "string", description: "The message, self-contained." },
        branch: { type: "string", description: "Only for a review agent: the branch to review." },
      },
      required: ["agent", "text"],
      additionalProperties: false,
    },
    // The dedupe key is derived from the call, so executing it again appends nothing.
    idempotent: true,
    async execute(raw, ctx) {
      const { agent, text, branch } = raw as { agent: unknown; text: unknown; branch?: unknown };
      if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
      const target = others().find((a) => a.name === agent);
      if (!target) throw new Error(`No other agent is named ${String(agent)}; the others are ${others().map((a) => a.name).join(", ")}.`);

      const { hop, replyThread, ownThread, trusted } = o.store.tx((t) => {
        const mine = t.listEvents(o.inboxId).filter((e) => e.resume === ctx.sessionId && e.status !== "dropped");
        const incoming = mine.filter((e) => e.source === "agent_message").map((e) => asMessage(e.payload));
        const first = mine[0];
        const opener = first?.source === "agent_message" ? asMessage(first.payload) : null;
        return {
          hop: Math.max(0, ...incoming.map((m) => m.hop)) + 1,
          // Only a session another agent opened answers into that agent's thread; any other send starts a new one.
          replyThread: opener?.from === target.name ? (opener.replyThread ?? null) : null,
          ownThread: t.primaryThread(ctx.sessionId),
          trusted: !t.getSession(ctx.sessionId)!.tainted,
        };
      });
      if (hop > MAX_HOPS) {
        throw new Error(
          `Not sent: this would be message ${hop} in one chain between agents, and the limit is ${MAX_HOPS}. ` +
            "Stop the exchange and call notify to tell the user where things stand.",
        );
      }
      if (branch !== undefined) {
        if (typeof branch !== "string" || branch === "") throw new Error("branch must be a non-empty string");
        if (target.role !== "review") throw new Error(`branch is only for a review agent; ${target.name} implements.`);
        if ((await target.worktrees.commitOf(branch)) === null) throw new Error(`There is no branch ${branch} in the repository.`);
      }

      const thread = replyThread ?? (await target.openThread(text));
      const payload: AgentMessage = {
        from: o.from,
        text,
        ...(branch === undefined ? {} : { branch }),
        hop,
        ...(ownThread === null ? {} : { replyThread: ownThread }),
      };
      appendEvent(
        { store: o.store, clock: o.clock, inboxId: target.inboxId },
        { source: "agent_message", dedupeKey: `send_to:${ctx.sessionId}:${ctx.callId}`, payload, thread, trusted },
      );
      target.wake();
      return { sent: true, to: target.name, thread };
    },
  };
}
