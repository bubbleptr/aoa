import type { ToolDef } from "@aoa-dev/kernel";
import type { Agent, Host } from "./host.ts";

/** How many agent messages one chain may carry; the next one is refused, so two agents cannot talk forever. */
export const MAX_HOPS = 4;

/** The payload of an `agent_message` event, plus whatever extra parameters the tool was given. */
export type AgentMessage = {
  from: string;
  text: string;
  /** 1 for a message sent from a session no agent opened; one more than the latest message the session got otherwise. */
  hop: number;
  /** The sender's thread, where a reply resumes the sender's session. */
  replyThread?: string;
  [extra: string]: unknown;
};

export type SendToArgs = { text: string; [extra: string]: unknown };

export type SendToOptions = {
  /** More parameters the model may pass, as JSON Schema properties; they go into the payload as given. */
  params?: Record<string, object>;
  /** Runs before anything is appended; what it throws is the model's error. */
  check?(target: Agent, args: SendToArgs): Promise<void>;
  /**
   * The thread a message that is not a reply opens in the target. Default `agent:<target>/<sender session>/<call>`:
   * its own session in the target, and the same thread if the call runs again.
   */
  thread?(target: Agent, args: SendToArgs, call: { sessionId: string; callId: string }): Promise<string>;
};

const asMessage = (payload: unknown) => payload as AgentMessage;

/**
 * `send_to` (design §15「多 agent」): appends a message to another agent of the host and wakes it. The message is as
 * trusted as the sending session: one that has only taken the user's word passes nothing from anyone else, while a
 * tainted one passes its taint on (design §12). A reply from a session another agent opened goes back to that agent's
 * thread, so it resumes the session that asked.
 */
export function sendToTool(host: Pick<Host, "agents">, o: SendToOptions = {}): ToolDef {
  const params = o.params ?? {};
  const senderOf = (sessionId: string) => host.agents.find((a) => a.read.sessions().some((s) => s.id === sessionId));
  return {
    name: "send_to",
    risk: "low",
    // Read when a run starts, so it lists agents registered after the tool was made. One tool serves every agent, so
    // the sender is among them; sending to yourself is refused.
    get description() {
      const listed = host.agents.map((a) => (a.description ? `${a.name} (${a.description})` : a.name)).join(", ");
      return (
        "Send a message to another agent; it arrives as an event in that agent's inbox. " +
        `The agents of this host, you among them: ${listed}. A reply resumes this task.`
      );
    },
    schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's name." },
        text: { type: "string", description: "The message, self-contained." },
        ...params,
      },
      required: ["agent", "text"],
      additionalProperties: false,
    },
    // The dedupe key and the default thread are derived from the call, so executing it again appends nothing new.
    idempotent: true,
    async execute(raw, ctx) {
      const { agent: name, text, ...rest } = raw as { agent: unknown; text: unknown; [k: string]: unknown };
      if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
      const sender = senderOf(ctx.sessionId);
      if (!sender) throw new Error(`No agent of this host has session ${ctx.sessionId}.`);
      const others = host.agents.filter((a) => a !== sender);
      if (name === sender.name) throw new Error(`You are ${sender.name}; send to one of the others: ${others.map((a) => a.name).join(", ")}.`);
      const target = others.find((a) => a.name === name);
      if (!target) throw new Error(`No other agent is named ${String(name)}; the others are ${others.map((a) => a.name).join(", ")}.`);
      const extra = Object.fromEntries(Object.entries(rest).filter(([k, v]) => k in params && v !== undefined));
      const args: SendToArgs = { text, ...extra };

      const mine = sender.read.events().filter((e) => e.resume === ctx.sessionId && e.status !== "dropped");
      const incoming = mine.filter((e) => e.source === "agent_message").map((e) => asMessage(e.payload));
      const hop = Math.max(0, ...incoming.map((m) => m.hop)) + 1;
      if (hop > MAX_HOPS) {
        throw new Error(
          `Not sent: this would be message ${hop} in one chain between agents, and the limit is ${MAX_HOPS}. ` +
            "Stop the exchange and call notify to tell the user where things stand.",
        );
      }
      await o.check?.(target, args);

      const opener = mine[0]?.source === "agent_message" ? asMessage(mine[0].payload) : null;
      // Only a session the target opened answers into the target's thread; any other send starts a new one.
      const replyThread = opener?.from === target.name ? (opener.replyThread ?? null) : null;
      const session = sender.read.sessions().find((s) => s.id === ctx.sessionId)!;
      const ownThread = sender.read.threads(ctx.sessionId)[0] ?? null;
      const thread =
        replyThread ??
        (o.thread
          ? await o.thread(target, args, { sessionId: ctx.sessionId, callId: ctx.callId })
          : `agent:${target.name}/${ctx.sessionId}/${ctx.callId}`);
      const payload: AgentMessage = { from: sender.name, text, ...extra, hop, ...(ownThread === null ? {} : { replyThread: ownThread }) };
      target.append({ source: "agent_message", dedupeKey: `send_to:${ctx.sessionId}:${ctx.callId}`, payload, thread, trusted: !session.tainted });
      return { sent: true, to: target.name, thread };
    },
  };
}
