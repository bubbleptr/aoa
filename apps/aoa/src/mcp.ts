import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { answer, close, messages, send, sendTo, status } from "./commands.ts";
import type { Agent } from "./wiring.ts";

const MAX_WAIT_SECONDS = 120;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/**
 * `aoa mcp`: the CLI's commands as MCP tools, on the store the CLI opens. It only appends to inboxes and reads;
 * `serve` runs the work. A thrown error becomes a tool error carrying the CLI's message.
 */
export function mcpServer(agent: Agent): McpServer {
  const server = new McpServer({ name: "aoa", version: "0.0.0" });

  server.registerTool(
    "send",
    {
      description:
        "Give aoa a task, or with `to` add to an existing one. Without `to` it opens a new task for the default agent, or " +
        "for the named `agent`; `branch` names the branch a review agent reviews. With `to` (a thread, or a prefix of a " +
        "thread or session id) the text continues that task; on a task waiting for an answer to its question, the text " +
        "is the answer. Returns the thread.",
      inputSchema: {
        text: z.string().describe("What to tell the agent."),
        agent: z.string().optional().describe("A named agent from the config; without it, the default agent."),
        branch: z.string().optional().describe("For a review agent: the branch to review."),
        to: z.string().optional().describe("The task to add to: a thread, or a prefix of a thread or session id."),
      },
    },
    async ({ text, agent: name, branch, to }) => {
      if (to !== undefined) {
        if (name !== undefined || branch !== undefined) {
          throw new Error("`to` finds the task in any agent's inbox; it takes neither `agent` nor `branch`.");
        }
        return json({ thread: sendTo(agent, to, text) });
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
        "with the returned cursor to keep waiting. An approval request carries the call id to `answer`.",
      inputSchema: {
        since: z.string().optional().describe("The cursor a previous call returned."),
        wait: z.number().min(0).max(MAX_WAIT_SECONDS).default(0).describe(`Seconds to wait for something new, 0 to ${MAX_WAIT_SECONDS}.`),
      },
    },
    async ({ since, wait }) => json(await messages(agent, { since: since ?? null, waitMs: wait * 1000 })),
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
      inputSchema: {
        thread: z.string().describe("The task: a thread, or a prefix of a thread or session id."),
        outcome: z.enum(["merged", "discarded"]),
      },
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
      inputSchema: {
        callId: z.string().describe("The call id, or a unique prefix of it, from `status` or `messages`."),
        verdict: z.enum(["approve", "deny"]),
        text: z.string().optional().describe("The user's reason, or their answer to a question."),
      },
    },
    async ({ callId, verdict, text }) => json({ callId: answer(agent, callId, verdict, text), verdict }),
  );

  return server;
}
