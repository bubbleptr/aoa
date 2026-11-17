# aoa

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Bun](https://img.shields.io/badge/Bun-1.3-14151a?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Runtimes](https://img.shields.io/badge/runtimes-pi%20%7C%20Codex%20%7C%20dsh-6f8fd6)
![Conformance](https://img.shields.io/badge/conformance-C1%E2%80%93C20-3f9a72)
![MCP](https://img.shields.io/badge/MCP-stdio-8a74cf)

[中文](README.md) · English

An Always-on Agent framework that runs 24x7 on an Inbox + Worker model. You hand it a task, it finishes the work on its own branch, and it only comes to you when it needs you.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-en-dark.png">
  <img alt="aoa architecture: the entry point is Claude over MCP, with webhooks planned; tasks enter the kernel's Inbox, the Worker loads Memory and starts a run on a runtime, tool calls come back to Permissions for a decision, messages and approval requests leave through the Outbox, and Timers wake things up when due; all state lives in SQLite; the runtimes are the built-in pi and the external harnesses Codex and dsh" src="docs/diagrams/architecture-en-light.png">
</picture>

- **Five primitives** live in the kernel: Inbox receives events, Timers wake things up when due, Memory keeps instructions, notes, progress and sent messages across runs, Permissions decides whether each tool call may run, and Outbox sends messages and retries delivery. All state is in one SQLite file, so the process picks up where it left off after a crash.
- **The Worker** claims a batch of events, starts a run on a runtime, and records how the run ended.
- **Runtimes come in two kinds.** The built-in pi only has the tools aoa gives it, and the kernel decides and logs every call. The external harnesses, Codex and dsh, use their own tools and sandboxes; whatever they would ask about is forwarded to you, and aoa's own tools still go through the kernel.
- You hand out tasks through the CLI, MCP or a GitHub issue. In local mode, messages are appended to `messages.md` with a desktop notification; in GitHub mode they are posted on the issue and the PR.

The design is in [docs/design.md](docs/design.md) and the spec in [docs/spec.md](docs/spec.md) (both in Chinese).

## Design and implementation

### A tool call

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/tool-call-en-dark.png">
  <img alt="A tool call: Permissions decides allow, block or defer, while Jev scores alongside for now and takes over the decision later; on defer the session is saved and the run ends, the Outbox sends an approval request, your answer comes back to the Inbox as an event, and a new run resumes the session and executes the call exactly once; in GitHub mode the host process adds credentials for the agent; a Codex review agent's approvals go to Codex's own auto review" src="docs/diagrams/tool-call-en-light.png">
</picture>

- **The agent makes most decisions itself.** Every tool call first goes through a rule table: read-only calls are allowed, and things like `sudo`, force pushes and `curl | sh` are blocked. Everything else goes to a classifier, the same idea as auto mode in Claude Code. Today the classifier is a small model, and the intent model Jev scores the same calls alongside it; once there is enough data, Jev takes over. A review agent on Codex uses Codex's own auto review. So most calls never wait for a person, and the agent keeps running.
- **When it needs you, it uses a deferred tool call.** For calls that are high-risk or that the classifier is unsure about, aoa saves the session, ends the run, and sends you an approval request through the outbox, while the worker moves on to other events. Your answer comes back into the inbox as a new event; the kernel runs that one call, and a new run picks up where it left off. Only your own answer counts, not issue bodies or messages from other agents.
- **Credentials are added by a proxy.** `git_push`, opening PRs and posting comments run in aoa's host process, which adds the GitHub credentials, so the agent never sees them.

### Multiple agents: implement plus review

Add `agents` to the config to run several named agents in the same `serve`. The top-level fields are the default agent; each named agent has its own inbox, worker, role, permissions and memory, and fields it leaves out (`model`, `classifier`, `risk`) come from the top level.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/multi-agent-en-dark.png">
  <img alt="Multiple agents: the implementation agent and the review agent each have their own Inbox, Worker and pi; the implementation agent hands its branch over with send_to and the review agent sends its findings back; both share one SQLite database whose tables are split by inbox" src="docs/diagrams/multi-agent-en-light.png">
</picture>

One inbox and one worker per agent: an inbox has at most one run at a time, while runs of different agents can proceed in parallel. Agents only cooperate by writing events into each other's inboxes, and all of them share one database and one clock.

- `implement` (default): writes code.
- `review`: read-only. No edit or write, and git commands that move refs or rewrite history are blocked.

```ts
agents: {
  reviewer: { role: "review", instructions: "Focus on missing tests." },
},
```

With a review agent configured, the implementation agent hands its branch over with `send_to` after committing. In a separate worktree pinned to that commit, the review agent checks that it merges cleanly, runs the tests, and confirms that new tests fail with the fix removed, then sends its findings back to the implementation agent and notifies you. The findings are advice only: merging, closing the task and answering approvals stay with you. The two agents exchange at most 4 messages before the thread is turned over to you.

A named agent's inbox is `local/<repo>@<name>`, its memory and worktrees live under `memory/local/<repo>@<name>/` and `worktrees/local/<repo>@<name>/`, and its branches are `aoa/<name>/<first 8 characters of the session id>`. `status`, `messages`, `answer`, `send --to` and `close` search all agents. Local mode only.

### Picking up after a crash

- The five stores and the supporting tables are all in one SQLite file, so ATOMIC in the spec is one transaction: the run's outcome, the session update and marking the events done commit together.
- Workers are kept apart by leases in the database, not by in-process locks: a claim is one transaction that succeeds only when the inbox has no unexpired lease. A failed batch of events is retried after 30 seconds and then 2 minutes; after three attempts it stops in `dead`, where `aoa status` shows it.
- Before a tool runs, its intent is recorded in `tool_journal`. On recovery, a call with an intent but no result is not rerun; instead "result unknown, check before deciding" is handed back to the agent as the tool result.
- Events are deduplicated by `(inbox, source, dedupe_key)`; the GitHub polling cursor is saved in the same transaction as the events, so a crash costs at most one extra poll. Failed outbox deliveries back off at 1, 2, 4 and 8 minutes.

### Conformance tests

Each of C1–C20 in §9 of the spec was written as a failing test before its implementation, and runs against a fake runtime with fault-injection points and a fake clock. Every commit point has a name (`after_append`, `after_claim`, `after_tool_exec`, `after_tool_result`, `before_complete`), and the tests kill the process at those points and recover.

## Quick start

1. Install [Bun](https://bun.sh). Run `bun install` at the repository root, then `bun link` in `apps/aoa`, and `aoa` works from any directory.
2. Copy `aoa.config.example.ts` to `~/.aoa/aoa.config.ts` and fill in the repository path and models. The config only names environment variables, never keys; it is looked up from `--config`, then `aoa.config.ts` in the current directory, then `~/.aoa/aoa.config.ts`.
3. Agents running on pi need a `classifier` model: without it every `bash` call waits for your approval, and the agent can neither run checks nor commit.
4. Start it and hand out work:

```bash
aoa serve                         # stays running; Ctrl-C to stop
aoa send "Fix the typo in README" # opens a task and prints its thread, e.g. local:1a2b3c4d
```

Without a `github` section you are in local mode: no GitHub, no pushes, no PRs.

## Commands

| Command | What it does |
|---|---|
| `aoa serve` | Stays running |
| `aoa send "<text>"` | Opens a task |
| `aoa send --agent <name> [--branch <branch>] "<text>"` | Hands work to a named agent; `--branch` names the branch a review agent should review |
| `aoa send --to <thread or prefix> "<text>"` | Continues a task; while it waits for an answer, `/approve` approves and anything else is a denial with reasons |
| `aoa answer <call id or prefix> approve\|deny [reason]` | Answers a call that is waiting on you |
| `aoa close <thread or session prefix> merged\|discarded` | Local mode: tells aoa how the branch ended |
| `aoa messages [--since <cursor>] [--wait <seconds>] [--json]` | What the agents have said, ending with a new cursor |
| `aoa status [--json] [--refresh]` | Tasks, outcomes, pending approvals, dead letters, failed messages, and each agent's runtime |
| `aoa mcp` | Exposes send, messages, status, close and answer as MCP tools over stdio |

## How a task goes (local mode)

- Each task gets its own worktree under `<dataDir>/worktrees/` and commits to the local branch `aoa/<first 8 characters of the session id>`.
- When the agent needs you, the message is appended to `<dataDir>/messages.md`, with a notification on macOS. When it needs approval, the message includes the matching `aoa answer` command.
- You review and merge the branch yourself, then tell aoa the outcome with `aoa close`. `close` only records it; at its next check (within 5 seconds) `serve` closes the task and removes the worktree, keeping the branch.
- A `git push` inside `bash` asks you first. This is a convention, not isolation: the agent's shell is your shell.

## Runtimes: pi, Codex, dsh

Each agent (top-level or named) picks one with `runtime`; the default is `pi`.

| | pi | Codex | dsh (DeepSeek Harness) |
|---|---|---|---|
| Kind | Built-in | External harness | External harness |
| Who decides tool calls | aoa decides every one | Codex's approval and sandbox settings; what it would ask is forwarded to you | The sandbox and approvals set by `dsh.preset`; what it would ask is forwarded to you |
| How it connects | An in-process pi session | A `codex app-server` per run | A `dsh --profile sdk` per run |
| aoa's own tools | Given to pi directly | Dynamic tools | An MCP bridge listening only on 127.0.0.1 |
| Auth | `model.apiKeyEnv` | Codex's own login; aoa does not touch it | `apiKeyEnv`, passed only to the dsh child process |
| Review role | Supported, with aoa's read-only rules | Supported, running in Codex's auto review mode | Not supported |
| Modes | Local and GitHub | Local only | Local only |

```ts
agents: {
  coder: { runtime: "codex", model: "your-codex-model-id" },             // model is optional; Codex's default is used
  deepseek: { runtime: "dsh", model: "deepseek-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
},
```

What the two external harnesses have in common:
- Whatever they would ask about becomes an aoa approval request; once you approve, they perform the same operation again and this time it goes through. The permission is used once.
- What they do without asking, aoa can neither see nor stop. aoa's push rule, `~/.aoa` rule and worktree boundary do not apply to their own tools; `serve` warns once per such agent at startup.

**Codex**
- Your Codex approval and sandbox settings apply as they are.
- Plugins, MCP servers and hooks you installed in Codex are not carried over; aoa turns them all off when it starts Codex.
- The review role runs in Codex's auto review mode (workspace-write sandbox, with approvals going to Codex's own auto reviewer rather than to you). Whether it can commit depends on Codex's review and the prompt, not on a hard limit.

**dsh**
- aoa gives it a separate home (`<dataDir>/dsh-home`) and writes a patch on every run: it sets the permission preset and turns off dsh's own subagents, team, goal, workflow, jobs and plugin management, as well as its own question and scheduling tools.
- `dsh.preset` defaults to `workspace-write`; `read-only` and `danger-full-access` are the alternatives. Changing the preset also switches tasks already under way before their next run.
- Before starting, aoa checks `dsh --version` and refuses to run anything other than the tested `0.2.2-rc.3`. dsh is still in developer preview, so a new version may need changes to the patch and the version constant.

## A chat agent as the entry point

aoa has no main session of its own. Talk to another chat agent (Claude Code, say) and have it run the commands:

```bash
aoa send "..."                           # hand out work and note the printed thread
aoa messages --since <cursor> --wait 600  # wait for the next message; the output ends with a new cursor
aoa answer <call id> approve|deny [reason]  # when the message is an approval request
```

`messages` reads the outbox, not `messages.md`, so it works in both modes; add `--json` for programs.

Harnesses that speak MCP don't need to run commands. `aoa mcp` offers the same five tools, reads and writes the same config and database, and does not need `serve` running. Register it once in Claude Code:

```bash
claude mcp add aoa -- aoa mcp
```

Convention: approvals belong to you. The chat agent only relays the request and calls `answer` after you have clearly approved or denied. Over MCP, `send` cannot be used to answer a task that is waiting for approval.

## Connecting GitHub (optional)

Add a `github` section to the config (see `aoa.config.example.ts`). Then create a GitHub App, install it on the target repository with read and write access to Issues, Pull requests and Contents, and keep the private key file on your machine.

After that:
- `send` opens a labeled issue; the agent pushes a branch, opens a PR and comments on the issue.
- Reply `/approve` or `/deny reason` in a comment.
- When the PR is merged or closed the task ends, and `aoa close` is not available; `status --refresh` checks the PR state on GitHub first.

## Development

A Bun + TypeScript monorepo.

| Package | What it does |
|---|---|
| `packages/kernel` | The five primitives, worker, policy and scheduling, independent of storage and models |
| `packages/store-sqlite` | SQLite storage and migrations |
| `packages/runtime-pi` · `runtime-codex` · `runtime-dsh` | The three runtime adapters |
| `packages/channel-local` · `channel-github` | Local and GitHub channels |
| `packages/conformance` | The C1–C20 conformance tests from §9 of the spec |
| `apps/aoa` | The `aoa` command: config, wiring, serve, MCP |

```bash
bun test               # all tests, no real models called
bun run typecheck
bun scripts/diagrams/build.ts   # rebuild the README diagrams from docs/diagrams/boards (needs Chrome)
AOA_CODEX_SMOKE=1 bun test packages/runtime-codex/test/smoke.test.ts   # real Codex, uses quota
AOA_DSH_SMOKE=1 bun test packages/runtime-dsh/test/smoke.test.ts       # real dsh and a DeepSeek key
```
