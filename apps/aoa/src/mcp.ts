import { McpServer, ProtocolError, ProtocolErrorCode, type ServerContext, type Transport } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { type Listing, answer, close, messages, send, sendTo, status } from "./commands.ts";
import { type Ask, TASKS_EXTENSION, type Wait, Waits, declaresFormElicitation, declaresTasks, waitOf } from "./mcp-wait.ts";
import type { PendingCall } from "@aoa-dev/sdk";
import type { Agent } from "./wiring.ts";

const MAX_WAIT_SECONDS = 120;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/**
 * `aoa mcp`: the CLI's commands as MCP tools, on the store the CLI opens. It only appends to inboxes and reads;
 * `serve` runs the work. A thrown error becomes a tool error carrying the CLI's message.
 */
export function mcpServer(agent: Agent): McpServer {
  const server = new McpServer({ name: "aoa", version: "0.0.0" });
  const waits = new Waits();

  /** Calls the user declined to answer by form on this connection: they stay waiting, and are not asked again. */
  const declined = new Set<string>();

  /**
   * The calls that wait on the user, in every agent's inbox. A call stays pending until its agent takes the answer, so
   * one with an answer already queued is left out: it waits on the agent now.
   */
  const waitingOnUser = () =>
    agent.host.snapshot(() =>
      agent.agents.flatMap((a) => {
        const answered = new Set(
          a.hosted.read
            .events()
            .filter((e) => e.source === "approval_answer" && e.status !== "dropped")
            .map((e) => (e.payload as { callId?: unknown }).callId),
        );
        return a.hosted.read
          .pending()
          .filter((d) => !answered.has(d.callId))
          .map((d) => ({ agent: a, call: d }));
      }),
    );

  /** The calls waiting on the user that a form may still ask. */
  const askable = () => waitingOnUser().filter(({ call }) => !declined.has(call.callId));

  /**
   * A waiting call as its form shows it: the whole request the outbox carries (never the clipped one `status` shows),
   * without the channel's reply instructions, under the agent and thread it comes from.
   */
  function asking(a: Agent, d: PendingCall): Ask {
    const request = agent.host.messages().find((m) => m.kind === "approval_request" && m.callId === d.callId);
    const lines = (request?.body ?? d.tool).split("\n");
    const reply = lines.findIndex((l) => l.startsWith("Reply `/approve`"));
    const body = (reply < 0 ? lines : lines.slice(0, reply)).join("\n").trim();
    const from = [agent.agents.length > 1 ? a.name : null, request?.thread ?? null].filter((x) => x !== null).join(" · ");
    return { callId: d.callId, question: d.kind === "question", message: from === "" ? body : `${from}\n\n${body}` };
  }

  /**
   * What a wait from `since` finds now: whether something new needs the caller, the calls to ask as forms, and the
   * listing it completes with. An approval request counts only while its call waits on the user and cannot be asked as
   * a form; one already answered is history, and the agent says something once it goes on.
   */
  async function look(since: string | null, ctx: ServerContext): Promise<{ settled: boolean; asks: Ask[]; listing: Listing }> {
    const listing = await messages(agent, { since, waitMs: 0 });
    const waiting = waitingOnUser();
    const asks = declaresFormElicitation(ctx)
      ? waiting.filter(({ call }) => !declined.has(call.callId)).map(({ agent: a, call }) => asking(a, call))
      : [];
    const unasked = new Set(waiting.map(({ call }) => call.callId).filter((id) => !asks.some((a) => a.callId === id)));
    const settled = listing.messages.some((m) => m.kind !== "approval_request" || unasked.has(m.callId!));
    return { settled, asks, listing };
  }

  function waitBehind(handle: string): Wait {
    const w = waitOf(handle);
    if (w === null) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No wait ${handle}.`);
    return w;
  }

  /** A wait's state now; an unknown cursor is the caller's error, as for `messages`. */
  async function stateOf(handle: string, ctx: ServerContext) {
    const w = waitBehind(handle);
    let found;
    try {
      found = await look(w.since, ctx);
    } catch (err) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
    return waits.state(handle, w, agent.clock.now(), { settled: found.settled, asks: found.asks, result: () => json(found.listing) });
  }

  server.registerTool(
    "send",
    {
      description:
        "Give aoa a task, or with `to` add to an existing one. Without `to` it opens a new task for the default agent, or " +
        "for the named `agent`; `branch` names the branch a review agent reviews. With `to` (a thread, or a prefix of a " +
        "thread or session id) the text continues that task; on a task waiting for an answer to its question, the text " +
        "is the answer. A task waiting for an approval is refused: approvals go through `answer`. Returns the thread.",
      inputSchema: z.object({
        text: z.string().describe("What to tell the agent."),
        agent: z.string().optional().describe("A named agent from the config; without it, the default agent."),
        branch: z.string().optional().describe("For a review agent: the branch to review."),
        to: z.string().optional().describe("The task to add to: a thread, or a prefix of a thread or session id."),
      }),
    },
    async ({ text, agent: name, branch, to }) => {
      if (to !== undefined) {
        if (name !== undefined || branch !== undefined) {
          throw new Error("`to` finds the task in any agent's inbox; it takes neither `agent` nor `branch`.");
        }
        return json({ thread: sendTo(agent, to, text, { refuseApproval: true }) });
      }
      return json({ thread: await send(agent, text, { ...(name === undefined ? {} : { agent: name }), ...(branch === undefined ? {} : { branch }) }) });
    },
  );

  server.registerTool(
    "messages",
    {
      description:
        "What aoa's agents said, oldest first, with a cursor. Pass the cursor as `since` to get only what came after it. " +
        "With `wait`, the call waits up to that many seconds for something new; when it returns empty, call it again " +
        "with the returned cursor to keep waiting. A client that declares MCP Tasks gets a task to poll instead, which " +
        "completes with the same listing once something new needs the caller; when the client can show forms, a call " +
        "waiting on the user goes to them as a form on that task instead. An approval request carries the call id to `answer`.",
      inputSchema: z.object({
        since: z.string().optional().describe("The cursor a previous call returned."),
        wait: z.number().min(0).max(MAX_WAIT_SECONDS).default(0).describe(`Seconds to wait for something new, 0 to ${MAX_WAIT_SECONDS}.`),
      }),
    },
    async ({ since, wait }, ctx) => {
      const from = since ?? null;
      if (wait > 0 && declaresTasks(ctx)) {
        const now = await look(from, ctx);
        // A CreateTaskResult is not a CallToolResult; the SDK passes it through to the wire as it is.
        if (!now.settled || now.asks.length > 0) return waits.start({ since: from, startedAt: agent.clock.now() }) as unknown as ReturnType<typeof json>;
        return json(now.listing);
      }
      return json(await messages(agent, { since: from, waitMs: wait * 1000 }));
    },
  );

  server.registerTool(
    "status",
    {
      description:
        "aoa's tasks with their state and outcome, the calls waiting for the user's approval or answer (with call ids " +
        "and what each asks), dead events and failed messages.",
    },
    async () => json(JSON.parse(await status(agent, { json: true, refresh: false }))),
  );

  server.registerTool(
    "close",
    {
      description:
        "Local mode only: record how a task's branch ended, after the user merged or discarded it. serve then closes " +
        "the task and removes its worktree, keeping the branch.",
      inputSchema: z.object({
        thread: z.string().describe("The task: a thread, or a prefix of a thread or session id."),
        outcome: z.enum(["merged", "discarded"]),
      }),
    },
    async ({ thread, outcome }) => {
      const session = close(agent, thread, outcome);
      return json({ session: session.id, outcome });
    },
  );

  server.registerTool(
    "answer",
    {
      description:
        "Answer a call that waits for the user: approve or deny an approval request, or answer a question. Only call " +
        "this after the user has explicitly said yes or no to that call in this conversation; never decide for them.",
      inputSchema: z.object({
        callId: z.string().describe("The call id, or a unique prefix of it, from `status` or `messages`."),
        verdict: z.enum(["approve", "deny"]),
        text: z.string().optional().describe("The user's reason, or their answer to a question."),
      }),
    },
    async ({ callId, verdict, text }) => json({ callId: answer(agent, callId, verdict, text, "mcp"), verdict }),
  );

  server.server.setRequestHandler("tasks/get", { params: z.object({ taskId: z.string() }) }, async ({ taskId }, ctx) => stateOf(taskId, ctx));
  // A form's answer takes the path the web page's does, marked as from a form; only a call this wait could ask, by its
  // whole id, is answered, and anything else is ignored as the Tasks extension asks for unknown keys.
  server.server.setRequestHandler("tasks/update", { params: z.object({ taskId: z.string() }) }, async ({ taskId }, ctx) => {
    waitBehind(taskId);
    const responses = (ctx.mcpReq.inputResponses ?? {}) as Record<string, { action?: unknown; content?: Record<string, unknown> }>;
    for (const { agent: a, call } of askable()) {
      const response = responses[call.callId];
      if (response === undefined) continue;
      const reply = formAnswer(call, response);
      if (reply === null) {
        declined.add(call.callId);
        continue;
      }
      try {
        a.hosted.answer(call.callId, { ...reply, via: "elicitation" });
      } catch {
        // Answered elsewhere and taken since the read above: that answer stands.
      }
    }
    return {};
  });
  server.server.setRequestHandler("tasks/cancel", { params: z.object({ taskId: z.string() }) }, async ({ taskId }) => {
    const w = waitBehind(taskId);
    for (const { call } of askable()) declined.add(call.callId);
    waits.cancel(taskId, w, agent.clock.now());
    return {};
  });
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });

  return server;
}

/**
 * The answer a form gives, or null when it gives none: declined, cancelled, or accepted without a decision or an
 * answer. Nothing defaults to approve, and a missing answer is not a denial: the call keeps waiting.
 */
function formAnswer(call: PendingCall, r: { action?: unknown; content?: Record<string, unknown> }): { verdict: "approve" | "deny"; text?: string } | null {
  if (r.action !== "accept") return null;
  const text = (key: string) => {
    const value = r.content?.[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  if (call.kind === "question") {
    const answer = text("answer");
    return answer === undefined ? null : { verdict: "approve", text: answer };
  }
  const decision = r.content?.decision;
  if (decision !== "approve" && decision !== "deny") return null;
  const reason = text("reason");
  return { verdict: decision, ...(reason === undefined ? {} : { text: reason }) };
}

/**
 * Serves `aoa mcp` on `transport` (stdio by default). The opening exchange picks the protocol era per connection, so a
 * 2025 client that initializes and a 2026-07-28 client that sends `server/discover` both work.
 */
export function serveMcp(agent: Agent, transport?: Transport): StdioServerHandle {
  return serveStdio(() => mcpServer(agent), transport ? { transport } : {});
}
