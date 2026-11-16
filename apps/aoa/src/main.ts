#!/usr/bin/env bun
import { answer, close, send, sendTo, status } from "./commands.ts";
import { loadConfig, validateForServe } from "./config.ts";
import { serve } from "./serve.ts";
import { type Seams, assemble } from "./wiring.ts";

export const HELP = `aoa: an always-on coding agent for one repository.

Without a github block in the config it runs in local mode: messages go to <dataDir>/messages.md and a
desktop notification, and work stays on local branches aoa/<id> that you merge yourself.

Usage:
  aoa serve                                   Run the agent until interrupted (Ctrl-C).
  aoa send "<text>"                           Open a task, picked up by serve (with GitHub: an issue with the text).
  aoa send --to <thread-or-prefix> "<text>"   Add to an existing task; on one waiting for an answer, the text answers it.
  aoa answer <call-id-or-prefix> approve|deny [text...]
                                              Answer a call that waits for you.
  aoa close <thread-or-session-prefix> merged|discarded
                                              Local mode: say how a task's branch ended; serve then closes the task
                                              and removes its worktree, keeping the branch.
  aoa status [--json] [--refresh]             Sessions, outcomes, pending approvals, dead events, failed messages.
                                              --refresh looks up pull request states on GitHub first.

Options:
  --config <path>   The config file (default: ./aoa.config.ts).
  --to <thread>     For send: the task to add to.
  -h, --help        Show this help.

On GitHub, reply to an approval request with /approve, or /deny followed by a reason.`;

export type Io = {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  seams?: Seams;
  /** Resolves when `serve` should stop; by default on SIGINT or SIGTERM. */
  stopSignal?: () => Promise<void>;
};

type Parsed = {
  command: string | undefined;
  args: string[];
  config: string;
  to: string | undefined;
  json: boolean;
  refresh: boolean;
  help: boolean;
};

function parse(argv: string[]): Parsed {
  const p: Parsed = { command: undefined, args: [], config: "aoa.config.ts", to: undefined, json: false, refresh: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--config needs a path");
      p.config = value;
    } else if (a.startsWith("--config=")) p.config = a.slice("--config=".length);
    else if (a === "--to") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--to needs a thread");
      p.to = value;
    } else if (a.startsWith("--to=")) p.to = a.slice("--to=".length);
    else if (a === "--json") p.json = true;
    else if (a === "--refresh") p.refresh = true;
    else if (a === "-h" || a === "--help") p.help = true;
    else if (p.command === undefined) p.command = a;
    else p.args.push(a);
  }
  return p;
}

const signals = () =>
  new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

/** Runs one command and returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (p.help || p.command === undefined || p.command === "help") {
    (p.command === undefined && !p.help ? io.err : io.out)(HELP);
    return p.command === undefined && !p.help ? 2 : 0;
  }
  if (!["serve", "send", "answer", "close", "status"].includes(p.command)) {
    io.err(`Unknown command "${p.command}".\n\n${HELP}`);
    return 2;
  }

  if (p.to !== undefined && p.command !== "send") {
    io.err(`--to is only for send.\n\n${HELP}`);
    return 2;
  }

  let agent;
  try {
    const config = await loadConfig(p.config, io.cwd);
    if (p.command === "serve") {
      validateForServe(config);
      const env = io.seams?.env ?? process.env;
      for (const m of [config.model, config.classifier]) {
        if (m && !env[m.apiKeyEnv]) throw new Error(`The model API key is missing: set the environment variable ${m.apiKeyEnv}.`);
      }
    }
    agent = assemble(config, io.seams);
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  try {
    switch (p.command) {
      case "serve": {
        await serve(agent, (io.stopSignal ?? signals)());
        return 0;
      }
      case "send": {
        const text = p.args.join(" ");
        io.out(p.to === undefined ? await send(agent, text) : sendTo(agent, p.to, text));
        return 0;
      }
      case "close": {
        const [target, result, ...rest] = p.args;
        if (target === undefined || result === undefined || rest.length > 0) {
          throw new Error("Usage: aoa close <thread-or-session-prefix> merged|discarded");
        }
        const session = close(agent, target, result);
        io.out(`Recorded session ${session.id} as ${result}; serve closes it and removes its worktree on its next check.`);
        return 0;
      }
      case "answer": {
        const [prefix, verdict, ...words] = p.args;
        if (prefix === undefined || verdict === undefined) throw new Error("Usage: aoa answer <call-id-or-prefix> approve|deny [text...]");
        const callId = answer(agent, prefix, verdict, words.length > 0 ? words.join(" ") : undefined);
        io.out(`Answered ${callId}: ${verdict}`);
        return 0;
      }
      default:
        io.out(await status(agent, { json: p.json, refresh: p.refresh }));
        return 0;
    }
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  } finally {
    agent.close();
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
  process.exit(code);
}
