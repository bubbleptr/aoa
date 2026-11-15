#!/usr/bin/env bun
import { answer, send, status } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { serve } from "./serve.ts";
import { type Seams, assemble } from "./wiring.ts";

export const HELP = `aoa: an always-on coding agent for one GitHub repository.

Usage:
  aoa serve                                   Run the agent until interrupted (Ctrl-C).
  aoa send "<text>"                           Open a task: a GitHub issue with the text, picked up by serve.
  aoa answer <call-id-or-prefix> approve|deny [text...]
                                              Answer a call that waits for you.
  aoa status [--json] [--refresh]             Sessions, outcomes, pending approvals, dead events, failed messages.
                                              --refresh looks up pull request states on GitHub first.

Options:
  --config <path>   The config file (default: ./aoa.config.ts).
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

type Parsed = { command: string | undefined; args: string[]; config: string; json: boolean; refresh: boolean; help: boolean };

function parse(argv: string[]): Parsed {
  const p: Parsed = { command: undefined, args: [], config: "aoa.config.ts", json: false, refresh: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--config needs a path");
      p.config = value;
    } else if (a.startsWith("--config=")) p.config = a.slice("--config=".length);
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
  if (!["serve", "send", "answer", "status"].includes(p.command)) {
    io.err(`Unknown command "${p.command}".\n\n${HELP}`);
    return 2;
  }

  let agent;
  try {
    agent = assemble(await loadConfig(p.config, io.cwd), io.seams);
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  try {
    switch (p.command) {
      case "serve": {
        const keyEnv = agent.config.model.apiKeyEnv;
        const env = io.seams?.env ?? process.env;
        if (!env[keyEnv]) throw new Error(`The model API key is missing: set the environment variable ${keyEnv}.`);
        await serve(agent, (io.stopSignal ?? signals)());
        return 0;
      }
      case "send": {
        const text = p.args.join(" ");
        io.out(await send(agent, text));
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
