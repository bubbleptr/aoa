# aoa

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/@aoa-dev/sdk?label=%40aoa-dev%2Fsdk)](https://www.npmjs.com/package/@aoa-dev/sdk)
![Bun](https://img.shields.io/badge/Bun-1.3-14151a?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Conformance](https://img.shields.io/badge/conformance-C1%E2%80%93C20-3f9a72)

[中文](README.md) · English

An SDK for building Always-on Agents on Bun. Agents run 24x7 on an Inbox + Worker model: events enter an inbox, a worker starts a run on a model, risky tool calls stop and wait for a person to approve, and the process can be killed at any time and pick up where it left off.

If you want a coding agent you can use right away, see the [`aoa` command](apps/aoa/README.en.md), built on this SDK.

## Install

Bun only (≥ 1.3); the packages ship TypeScript source.

```bash
bun add @aoa-dev/sdk @aoa-dev/store-sqlite
# For the built-in pi runtime, add its peer dependencies
bun add @earendil-works/pi-ai@1.5.2 @earendil-works/pi-coding-agent@1.5.2 typebox@1.3.27
```

## An example

An agent that can send email. Sending email is a high-risk tool, so the kernel stops and asks for approval first, and only after approval runs the call, exactly once.

```ts
import { createHost, type ToolDef } from "@aoa-dev/sdk";
import { piRuntime } from "@aoa-dev/sdk/pi";
import { sqliteStore } from "@aoa-dev/store-sqlite";

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

const host = createHost({ store: sqliteStore("agent.db") });
const agent = host.agent({
  name: "assistant",
  inbox: "assistant",
  runtime: piRuntime({
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: process.env.DEEPSEEK_API_KEY,
    agentDir: ".aoa/pi",
    sessionsDir: ".aoa/sessions",
    cwd: process.cwd(),
    systemPrompt: "You are a helpful assistant. When a task is done, tell the user with notify.",
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

You first see an `[approval_request]`, then `sending { ... }`. The process stays running; exit with Ctrl-C. The agent only messages you when it calls `notify`; the model's last words are not sent on their own, so sometimes a finished task has no message.

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
    classify: piClassifier({ provider: "deepseek", modelId: "deepseek-flash", apiKey: process.env.DEEPSEEK_API_KEY }),
  },
});
```

`piClassifier`'s prompt is written for a coding agent; elsewhere, write your own `classify`: it gets the call and whether the session has taken in others' content, and returns `allow`, `block` or `unsure`.

Deferring is a deferred tool call: the kernel saves the session, ends the run, and puts an approval request in the outbox, while the worker moves on to other events. The answer from `agent.answer` enters the inbox as a new event; the kernel runs that one call, and a new run picks up where it left off. Only `answer` or a trusted `user_message` counts, not content written by others or messages from other agents.

The kernel's own tools (timers, notify, memory, `send_to`) mark themselves `low`. The coding tools bash, read, edit and write, with their rules, are in the optional `@aoa-dev/sdk/tools/coding` and are not installed by default.

## Runtimes

- **Tier 1: pi**, built in at `@aoa-dev/sdk/pi`. pi only has the tools aoa gives it, and the kernel decides and logs every call.
- **Tier 2: external harnesses**, which use their own tools and sandboxes; what they would ask about becomes an aoa approval request. The SDK only defines the interface and ships no implementation; [`examples/codex`](examples/codex) and [`examples/dsh`](examples/dsh) show two ways to write one.

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
| [`examples/digest`](examples/digest) | An agent that doesn't write code: it checks issues once a day and speaks only when needed |
| [`examples/codex`](examples/codex) · [`examples/dsh`](examples/dsh) | Tier-2 harness adapters |
| [`apps/aoa`](apps/aoa/README.en.md) | The `aoa` command: a coding agent with a CLI, MCP, GitHub and an observation page |

The API may change in breaking ways during 0.x. The design is in [docs/design/](docs/design/README.md), the SDK's step-by-step tradeoffs in [docs/design/sdk.md](docs/design/sdk.md), and the spec in [docs/spec.md](docs/spec.md) (all in Chinese).

## Development

A Bun + TypeScript monorepo.

| Package | What it does |
|---|---|
| `packages/kernel` | The five primitives, worker, policy and scheduling, independent of storage and models |
| `packages/store-sqlite` | SQLite storage and migrations |
| `packages/sdk` | The host that assembles agents, the built-in pi runtime (`@aoa-dev/sdk/pi`), and the optional coding tools and rules (`@aoa-dev/sdk/tools/coding`) |
| `packages/channels/`: `local` · `github` | Local and GitHub channels |
| `packages/conformance` | The C1–C20 conformance tests from §9 of the spec |
| `examples/` | See the previous section |
| `apps/aoa` | The `aoa` command |

```bash
bun test               # all tests, no real models called
bun run typecheck
bun scripts/diagrams/build.ts   # rebuild the diagrams in the apps/aoa README from docs/diagrams/boards (needs Chrome)
```
