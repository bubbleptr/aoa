# aoa

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/@aoa-dev/sdk?label=%40aoa-dev%2Fsdk)](https://www.npmjs.com/package/@aoa-dev/sdk)
![Bun](https://img.shields.io/badge/Bun-1.3-14151a?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Conformance](https://img.shields.io/badge/conformance-C1%E2%80%93C20-3f9a72)

[中文](README.md) · English

An SDK for building Always-on Agents on Bun. Agents run 24x7 on an Inbox + Worker model: events enter an inbox, a worker starts a run on a model, risky tool calls stop and wait for a person to approve, and the process can be killed at any time and pick up where it left off.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/sdk-en-dark.png">
  <img alt="aoa SDK architecture: your app writes events and approval answers to the Inbox with append and answer, sets timers with schedule and followUp, and reads the Outbox with messages and watch; each agent has an Inbox, Worker, Timers, Memory, Outbox, Permissions and Tools, and several agents can message each other with send_to; the Worker hands a run to a runtime, tier 1 being the dependency-free loop and tier 2 an external harness, with Codex and dsh adapters in examples/; the runtime's tool calls come back to Permissions, allowed ones run in Tools and ones needing approval go out through the Outbox; every agent shares one SQLite file" src="docs/diagrams/sdk-en-light.png">
</picture>

If you want a coding agent you can use right away, see the [`aoa` command](apps/aoa/README.en.md), built on this SDK.

## Install

Bun only (≥ 1.3); the packages ship TypeScript source.

```bash
bun add @aoa-dev/sdk
```

## An example

An agent that can send email. Sending email is a high-risk tool, so the kernel stops and asks for approval first, and only after approval runs the call, exactly once.

```ts
import { createHost, sqliteStore, type ToolDef } from "@aoa-dev/sdk";
import { dirTranscripts, loopRuntime, type LoopComplete, type LoopTurn } from "@aoa-dev/sdk/loop";

const sendEmail: ToolDef = {
  name: "send_email",
  description: "Send an email.",
  schema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] },
  risk: "high",
  async execute(args) {
    console.log("sending", args);
    return { sent: true };
  },
};

// One model turn over an OpenAI-compatible API; any model SDK works the same way.
const toChat = (m: LoopTurn) =>
  m.role === "tool"
    ? { role: "tool", tool_call_id: m.callId, content: m.content }
    : m.role === "assistant"
      ? { role: "assistant", content: m.text ?? "", tool_calls: m.toolCalls?.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : m;
type ChatReply = { choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
const complete: LoopComplete = async ({ systemPrompt, messages, tools, signal }) => {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [{ role: "system", content: systemPrompt }, ...messages.map(toChat)],
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
    }),
  });
  if (!res.ok) throw new Error(`model request failed: ${res.status}`);
  const msg = ((await res.json()) as ChatReply).choices[0]!.message;
  return {
    text: msg.content ?? "",
    toolCalls: msg.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments) })),
  };
};

const host = createHost({ store: sqliteStore("agent.db") });
const agent = host.agent({
  name: "assistant",
  inbox: "assistant",
  runtime: loopRuntime({
    systemPrompt: "You are a helpful assistant. When a task is done, tell the user with notify.",
    complete,
    transcripts: dirTranscripts(".aoa/sessions"),
  }),
  tools: [sendEmail],
});

// Every message the agent sends goes to the outbox; with no channel, read it from host.messages().
let seen = host.messages().at(-1)?.id;
const answered = new Set<string>();
host.watch(() => {
  for (const m of host.messages(seen ? { since: seen } : {})) console.log(`[${m.kind}] ${m.body}`);
  seen = host.messages().at(-1)?.id ?? seen;
  // The example approves on the spot; a real application hands the decision to a person here.
  // A call stays pending until a new run takes it up, so answer it once.
  for (const call of agent.read.pending()) {
    if (answered.has(call.callId)) continue;
    answered.add(call.callId);
    agent.answer(call.callId, { verdict: "approve" });
  }
});

agent.append({
  source: "user_message",
  dedupeKey: crypto.randomUUID(),
  payload: { text: "Email bob@example.com: the build is green." },
  trusted: true,
});
host.start();
```

```bash
DEEPSEEK_API_KEY=... bun main.ts
```

You first see an `[approval_request]`, then `sending { ... }`. The process stays running; exit with Ctrl-C. By default an agent runs in quiet background mode and only messages you when it calls `notify`; for chat assistants pass `reply: "final_text"` so the model's final reply enters the outbox automatically (pair with `approvals: { by: "answer" }` and `OutMsg.detail` for interactive approval cards and buttons).

## Primitives

They all live in the kernel, and all state is in one SQLite file.

- **Inbox** receives events. Append with `agent.append`; events are deduplicated by `(source, dedupeKey)`, and `thread` groups the events of one conversation into one session. `trusted` is set by whoever appends, saying whether the content comes from the user; the SDK does not judge who the caller is.
- **Worker** claims a batch of events, starts a run on the runtime, and records how the run ended. An inbox has at most one run at a time; runs of different agents can proceed in parallel.
- **Timers** wake things up when due: `agent.followUp` for once, `agent.schedule({ id })` for a recurring timer that a restart does not duplicate.
- **Memory** keeps instructions, notes and progress across runs, when you pass `memory` (`dirMemory`, for instance).
- **Permissions** decide whether each tool call may run; see the next section.
- **Outbox** sends messages and retries delivery. With a `channel` they go there (a local file, GitHub and so on); without one a message counts as sent when written, and you read it from `host.messages()`.

Also: `host.watch` tells you when the database has a commit, including another process's within a second; `agent.read` queries sessions, events, pending calls, timers, runs and journals, read-only; `agent.activity` streams the model's text and each tool call as they happen; `agent.abort` stops the run in flight on one session and puts its events back to run again (since 0.1.1).

## Permissions

Each tool call is decided in order:

1. The first rule in `policy.rules` with an opinion: allow, block or defer.
2. If no rule decides, the risk tier: the tool's own `risk`, overridable by `policy.risk`, and `high` when neither is set.
3. `low` runs, `high` defers to a person, and `medium` goes to `policy.classify`; with no classifier, an error or an unsure answer, it defers too.

```ts
host.agent({
  name: "assistant",
  inbox: "assistant",
  runtime,
  tools: [sendEmail],
  policy: {
    rules: [{ name: "no-prod", match: (call) => (JSON.stringify(call.args).includes("prod") ? "block" : null) }],
    risk: { send_email: "medium" },
    classify: async (call, ctx) => "unsure", // swap in your own model judgment; "unsure" hands the call to a person
  },
});
```

`classify` gets the call and whether the session has taken in others' content, and returns `allow`, `block` or `unsure`. The `aoa` command uses `piClassifier`, written for a coding agent, from the in-repo `packages/pi`.

Deferring is a deferred tool call: the kernel saves the session, ends the run, and puts an approval request in the outbox, while the worker moves on to other events. The answer from `agent.answer` enters the inbox as a new event; the kernel runs that one call, and a new run picks up where it left off. Only `answer` or a trusted `user_message` counts, not content written by others or messages from other agents.

The kernel's own tools (timers, notify, memory, `send_to`) mark themselves `low`. The coding rules are in the optional `@aoa-dev/sdk/tools/coding` and are not installed by default; the bash, read, edit and write tools themselves are pi's, in the in-repo `packages/pi`.

## Runtimes

- **Tier 1 (the kernel decides and journals every tool call)**: `@aoa-dev/sdk/loop` has zero third-party dependencies; pass a single `complete()` function to plug in any model SDK or plain `fetch`. The SDK bundles no vendor runtime; the in-repo `packages/pi` (`@aoa-dev/pi`, unpublished) wires pi in as tier 1 for the `aoa` command and [`examples/tui`](examples/tui).
- **Tier 2: external harnesses** (`HarnessRuntime`), which use their own tools and sandboxes and relay approvals through `ask`; the SDK defines the interface and verifies its six conventions in conformance tests, without bundling vendor harness adapters.

### With MCP 2.0 and OAR

[OAR](https://github.com/botiverse/oar) (Open Agent Runtime) drives Claude Code, Codex, Pi and other coding harnesses through one API, so it can supply tier-2 runtimes. On the other side, MCP 2.0's Skills, Tasks and Elicitation let any MCP agent hand out work: Skills ship the manual, Tasks make each dispatch a background task whose result goes straight back to the caller, and Elicitation puts a worker's question in front of the user.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/mcp-oar-en-dark.png">
  <img alt="aoa with MCP 2.0 and OAR: on the left, any MCP agent connects through Skills (the manual), Tasks (dispatch and result) and Elicitation (questions); in the middle, the aoa kernel has Inbox, Worker, Timers, Memory, Permissions and Outbox, with state in SQLite; on the right, OAR controls sessions with prompt, steer and abort, records facts as records, and returns approvals and questions to the kernel as requests, driving Claude Code, Codex, Pi, Kimi Code, Grok Build, OpenCode and more. This shows how they fit together; aoa does not ship an OAR adapter or an MCP 2.0 entry yet" src="docs/diagrams/mcp-oar-en-light.png">
</picture>

This shows how they fit together: aoa does not ship an OAR adapter or an MCP 2.0 entry yet. Plugging OAR in means implementing `HarnessRuntime`.

## Multiple agents

One host holds several agents that share one database and one clock. Agents only cooperate by writing events into each other's inboxes, and `send_to` is the ready-made tool for it:

```ts
const sendTo = sendToTool(host);
host.agent({ name: "writer", description: "drafts replies", inbox: "writer", runtime, tools: [sendTo] });
host.agent({ name: "checker", description: "checks drafts", inbox: "checker", runtime, tools: [sendTo] });
```

A reply goes back to the session that sent the message. One chain carries at most 4 agent messages and the next is refused, so two agents cannot talk forever.

## Picking up after a crash

- **The process can be killed at any time.** When a run ends, its result, the session and "these events are done" are written in one transaction. After a restart, unfinished events are still in the inbox and get picked up again.
- **Claims expire.** A worker records an expiry in the database when it takes events (5 minutes, renewed while running); if it hasn't finished by then, the attempt counts as failed. Failed events are retried after 30 seconds and 2 minutes, and after three failures they become dead letters and are not retried; a dead letter that belongs to a session puts a notice in the outbox.
- **A rerun doesn't execute a tool twice.** Before a tool runs, the kernel makes a note; when a rerun meets a call that was noted but has no result, it doesn't execute it again and tells the agent "result unknown, check before deciding" instead. Tools marked `idempotent` are the exception.
- **Events and messages aren't duplicated.** Events are deduplicated by source; failed outbox deliveries are retried after 1, 2, 4 and 8 minutes, and marked failed after five attempts.

### Conformance tests

Each of C1–C20 in §9 of the [spec](docs/spec.md) was written as a failing test before its implementation, and runs against a fake runtime with fault-injection points and a fake clock. Every commit point has a name (`after_append`, `after_claim`, `after_tool_exec`, `after_tool_result`, `before_complete`), and the tests kill the process at those points and recover.

## Examples and applications

| | |
|---|---|
| [`examples/tui`](examples/tui) | Minimal terminal chat agent on `@aoa-dev/pi`: live streaming, read-only rules, `/y` approvals, Ctrl-C abort and SQLite persistence |
| [`apps/aoa`](apps/aoa/README.en.md) | The `aoa` command: a background coding agent with a CLI, MCP, GitHub and an observation page |

The API may change in breaking ways during 0.x. The design is in [docs/design/](docs/design/README.md), the SDK's step-by-step tradeoffs in [docs/design/sdk.md](docs/design/sdk.md), and the spec in [docs/spec.md](docs/spec.md) (all in Chinese).

## Development

A Bun + TypeScript monorepo.

| Package | What it does |
|---|---|
| `packages/sdk` | The single published package `@aoa-dev/sdk`: the five primitives, SQLite storage (`sqliteStore`), host, `@aoa-dev/sdk/loop`, and optional coding rules (`@aoa-dev/sdk/tools/coding`) |
| `packages/pi` | `@aoa-dev/pi` (unpublished): pi as a tier-1 runtime, `piClassifier`, and pi's coding tools (used by the `aoa` command and `examples/tui`) |
| `packages/channels/`: `local` · `github` | Local and GitHub channels (used by `apps/aoa`) |
| `packages/conformance` | The C1–C20 conformance tests from §9 of the spec |
| `examples/tui` | Minimal terminal chat example |
| `apps/aoa` | The `aoa` command |

```bash
bun test               # all tests, no real models called
bun run typecheck
bun scripts/diagrams/build.ts   # rebuild the README diagrams from docs/diagrams/boards (needs Chrome)
```
