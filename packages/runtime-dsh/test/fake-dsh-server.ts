import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DshLaunch, DshProcess, DshSpawn } from "../src/connection.ts";

/** What a scripted turn can do: ask the client things, call aoa's tools, and tell it things. */
export type FakeTurn = {
  /** The dsh session the prompt named. */
  sessionId: string;
  /** The text of the prompt. */
  text: string;
  /** aoa's MCP bridge for this run, read out of the patch file dsh was started with. */
  mcpUrl: string;
  request<T = any>(method: string, params: object): Promise<T>;
  notify(method: string, params: object): void;
  /** Logs a `tool/call` the way dsh does, and waits until the runtime has read it. */
  toolCall(callId: string, tool: string, args: object): Promise<void>;
  /** Logs a `tool/ptc-dispatch-start` the way a run_code sub-call does, and waits until it was read. */
  ptcCall(subCallId: string, tool: string, args: object): Promise<void>;
  /** Calls one of aoa's tools through the bridge, as dsh's MCP client would. */
  mcp(tool: string, args: object): Promise<{ text: string; isError: boolean }>;
  /** The tools the bridge offers dsh, as dsh's MCP client lists them. */
  mcpTools(): Promise<string[]>;
  /** The process dies mid-turn: its output ends and it exits with `why`. */
  die(why: string): void;
};

/** A turn's script; when it returns the session goes idle, unless the process died first. */
export type TurnScript = (t: FakeTurn) => Promise<void>;

export type ServerRequest = { method: string; params: any; reply: any };

/** Lines the fake writes to the client, as an async iterable that ends when the process is killed. */
class LineQueue implements AsyncIterable<string> {
  private readonly queued: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  private readonly drained: (() => void)[] = [];

  push(line: string): void {
    if (this.ended) return;
    this.queued.push(line);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  /** Resolves once everything pushed so far has been read; the reader handles a line before asking for the next. */
  consumed(): Promise<void> {
    if (this.queued.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.queued.length > 0) {
        const line = this.queued.shift()!;
        yield line;
        if (this.queued.length === 0) for (const done of this.drained.splice(0)) done();
      } else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * A scripted `dsh --profile sdk`, in process: it answers the SDK requests the way the real one does, plays one
 * script per prompt, calls aoa's MCP bridge as dsh's own MCP client would, and records everything. Nothing is
 * spawned and nothing leaves the process.
 */
export class FakeDshServer {
  /** Every launch the runtime asked for, with its arguments and environment. */
  readonly launches: DshLaunch[] = [];
  /** The `--version` commands the runtime ran. */
  readonly versionChecks: string[] = [];
  /** Each launch's patch file, as text, read when the process started. */
  readonly patches: string[] = [];
  /** Every request and notification the client sent, in order. */
  readonly received: { method: string; params: any }[] = [];
  /** Every request this server sent, with the client's reply (its `result`, or `{ error }`). */
  readonly serverRequests: ServerRequest[] = [];
  /** Prompt texts, in order. */
  readonly inputs: string[] = [];
  /** The signals each process was killed with, in order. */
  readonly kills: ("SIGTERM" | "SIGKILL")[] = [];
  /** What `<command> --version` prints. */
  version = "0.2.2-rc.3";
  /** Whether `shutdown` is answered. A server that ignores it is killed after the run's grace. */
  answerShutdown = true;
  /** Whether the process stays alive after answering `shutdown`, so a test can watch what comes next. */
  stayAfterShutdown = false;
  live = 0;
  private turns = 0;

  constructor(private readonly scripts: TurnScript[] = []) {}

  /** Appends scripts for later turns. */
  script(...more: TurnScript[]): void {
    this.scripts.push(...more);
  }

  sent(method: string): any[] {
    return this.received.filter((m) => m.method === method).map((m) => m.params);
  }

  /** The patch file of the last launch, as text. */
  patch(): string {
    const text = this.patches.at(-1);
    if (text === undefined) throw new Error("no launch yet");
    return text;
  }

  readonly spawn: DshSpawn = {
    version: async (command) => {
      this.versionChecks.push(command);
      return this.version;
    },
    spawn: (launch) => {
      this.launches.push(launch);
      this.live++;
      const out = new LineQueue();
      let exit!: (why: string) => void;
      const exited = new Promise<string>((resolve) => (exit = resolve));
      const waiting = new Map<string, (reply: any) => void>();
      let seq = 0;
      let killed = false;
      let client: Promise<Client> | null = null;
      const send = (m: object) => out.push(JSON.stringify(m));
      const patch = readFileSync(launch.args[launch.args.indexOf("--patch") + 1]!, "utf8");
      this.patches.push(patch);
      const mcpUrl = /^\s+url:\s+(\S+)\s*$/m.exec(patch)?.[1] ?? "";

      const mcp = async (): Promise<Client> => {
        client ??= (async () => {
          const c = new Client({ name: "fake-dsh", version: "0.0.0" });
          await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
          return c;
        })();
        return client;
      };

      const runTurn = async (sessionId: string, text: string) => {
        const script = this.scripts[this.turns++] ?? (async () => {});
        const turn: FakeTurn = {
          sessionId,
          text,
          mcpUrl,
          request: (method, params) => {
            const id = `srv-${++seq}`;
            const entry: ServerRequest = { method, params, reply: undefined };
            this.serverRequests.push(entry);
            send({ jsonrpc: "2.0", id, method, params });
            return new Promise((resolve) =>
              waiting.set(id, (reply) => {
                entry.reply = reply;
                resolve(reply);
              }),
            );
          },
          notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
          toolCall: async (callId, tool, args) => {
            send({
              jsonrpc: "2.0",
              method: "session.event",
              params: { sessionId, event: { type: "tool/call", data: { turn: this.turns, step: 0, callId, name: tool, arguments: args } } },
            });
            await out.consumed();
          },
          ptcCall: async (subCallId, tool, args) => {
            send({
              jsonrpc: "2.0",
              method: "session.event",
              params: { sessionId, event: { type: "tool/ptc-dispatch-start", data: { rootCallId: "root", parentCallId: "parent", subCallId, name: tool, arguments: args } } },
            });
            await out.consumed();
          },
          mcpTools: async () => (await (await mcp()).listTools()).tools.map((t) => t.name),
          mcp: async (tool, args) => {
            const reply = await (await mcp()).callTool({ name: tool, arguments: args as { [k: string]: unknown } });
            const content = (reply.content ?? []) as { type: string; text?: string }[];
            return {
              text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
              isError: reply.isError === true,
            };
          },
          die: (why) => {
            killed = true;
            this.live--;
            out.end();
            exit(why);
          },
        };
        await script(turn);
        if (killed) return;
        send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: "idle" } });
      };

      const handle = (m: any) => {
        if (m.method === undefined) {
          waiting.get(m.id)?.(m.error ? { error: m.error } : m.result);
          waiting.delete(m.id);
          return;
        }
        this.received.push({ method: m.method, params: m.params });
        const reply = (result: object) => send({ jsonrpc: "2.0", id: m.id, result });
        switch (m.method) {
          case "initialize":
            return reply({ serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } });
          case "session/resume":
            return reply({});
          case "session/prompt": {
            const text = (m.params.contentBlocks as { type: string; text?: string }[]).map((b) => b.text ?? "").join("");
            this.inputs.push(text);
            reply({ messageId: `msg-${this.turns + 1}` });
            void runTurn(m.params.sessionId, text);
            return;
          }
          case "shutdown":
            if (!this.answerShutdown) return;
            reply({});
            if (this.stayAfterShutdown) return;
            killed = true;
            this.live--;
            out.end();
            exit("shutdown");
            return;
          default:
            send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
        }
      };

      const proc: DshProcess = {
        write: (line) => {
          if (!killed) queueMicrotask(() => handle(JSON.parse(line)));
        },
        lines: out,
        exited,
        kill: (signal) => {
          this.kills.push(signal);
          if (killed) return;
          killed = true;
          this.live--;
          out.end();
          exit(`killed with ${signal}`);
        },
      };
      return proc;
    },
  };
}

/** A process that dies right after it starts, as a missing install would. */
export const dyingDsh: DshSpawn = {
  version: async () => "0.2.2-rc.3",
  spawn: () => {
    const out = new LineQueue();
    out.end();
    return { write: () => {}, lines: out, exited: Promise.resolve("dsh exited with code 1: cannot find package"), kill: () => {} };
  },
};
