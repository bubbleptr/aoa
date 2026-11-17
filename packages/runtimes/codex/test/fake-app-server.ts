import type { CodexProcess, SpawnCodex } from "../src/connection.ts";

/** What a scripted turn can do: ask the client things and tell it things. */
export type FakeTurn = {
  threadId: string;
  turnId: string;
  /** The text of the turn's input. */
  text: string;
  request<T = any>(method: string, params: object): Promise<T>;
  notify(method: string, params: object): void;
  /** The process dies mid-turn: its output ends and it exits with `why`. */
  die(why: string): void;
};

/** A turn's script; it may end the turn as failed, otherwise the turn completes (or reports the interrupt). */
export type TurnScript = (t: FakeTurn) => Promise<void | { failed: string }>;

export type ServerRequest = { method: string; params: any; reply: any };

/** Lines the fake writes to the client, as an async iterable that ends when the process is killed. */
class LineQueue implements AsyncIterable<string> {
  private readonly queued: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;

  push(line: string): void {
    if (this.ended) return;
    this.queued.push(line);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.queued.length > 0) yield this.queued.shift()!;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * A scripted `codex app-server`, in process: it answers the client's requests the way the real one does, plays one
 * script per turn, and records everything. Nothing is spawned.
 */
export class FakeAppServer {
  /** The working directory of every process the runtime started. */
  readonly spawns: string[] = [];
  /** Every request and notification the client sent, in order. */
  readonly received: { method: string; params: any }[] = [];
  /** Every request this server sent, with the client's reply (its `result`, or `{ error }`). */
  readonly serverRequests: ServerRequest[] = [];
  /** Turn inputs, in order. */
  readonly inputs: string[] = [];
  live = 0;
  private threads = 0;
  private turns = 0;

  constructor(private readonly scripts: TurnScript[] = []) {}

  /** Appends scripts for later turns. */
  script(...more: TurnScript[]): void {
    this.scripts.push(...more);
  }

  sent(method: string): any[] {
    return this.received.filter((m) => m.method === method).map((m) => m.params);
  }

  readonly spawn: SpawnCodex = (cwd) => {
    this.spawns.push(cwd);
    this.live++;
    const out = new LineQueue();
    let exit!: (why: string) => void;
    const exited = new Promise<string>((resolve) => (exit = resolve));
    const waiting = new Map<string, (reply: any) => void>();
    let seq = 0;
    let killed = false;
    let interrupted = false;
    const send = (m: object) => out.push(JSON.stringify(m));

    const runTurn = async (threadId: string, turnId: string, text: string) => {
      const script = this.scripts[this.turns++] ?? (async () => {});
      const turn: FakeTurn = {
        threadId,
        turnId,
        text,
        request: (method, params) => {
          const id = `srv-${++seq}`;
          const entry: ServerRequest = { method, params, reply: undefined };
          this.serverRequests.push(entry);
          send({ id, method, params });
          return new Promise((resolve) =>
            waiting.set(id, (reply) => {
              entry.reply = reply;
              resolve(reply);
            }),
          );
        },
        notify: (method, params) => send({ method, params }),
        die: (why) => {
          killed = true;
          this.live--;
          out.end();
          exit(why);
        },
      };
      const end = await script(turn);
      const status = end ? "failed" : interrupted ? "interrupted" : "completed";
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, error: end ? { message: end.failed } : null } } });
    };

    const handle = (m: any) => {
      if (m.method === undefined) {
        waiting.get(m.id)?.(m.error ? { error: m.error } : m.result);
        waiting.delete(m.id);
        return;
      }
      this.received.push({ method: m.method, params: m.params });
      const reply = (result: object) => send({ id: m.id, result });
      switch (m.method) {
        case "initialize":
          return reply({ userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" });
        case "initialized":
          return;
        case "thread/start":
          return reply({ thread: { id: `thread-${++this.threads}` } });
        case "thread/resume":
          return reply({ thread: { id: m.params.threadId } });
        case "turn/start": {
          const turnId = `turn-${this.turns + 1}`;
          const text = m.params.input.map((i: { text: string }) => i.text).join("");
          this.inputs.push(text);
          reply({ turn: { id: turnId, status: "inProgress", error: null } });
          void runTurn(m.params.threadId, turnId, text);
          return;
        }
        case "turn/interrupt":
          interrupted = true;
          return reply({});
        default:
          send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
      }
    };

    const proc: CodexProcess = {
      write: (line) => {
        if (!killed) queueMicrotask(() => handle(JSON.parse(line)));
      },
      lines: out,
      exited,
      kill: () => {
        if (killed) return;
        killed = true;
        this.live--;
        out.end();
        exit("killed");
      },
    };
    return proc;
  };
}

/** A process that dies right after it starts, as a missing login or a crash would. */
export const dyingProcess: SpawnCodex = () => {
  const out = new LineQueue();
  out.end();
  return { write: () => {}, lines: out, exited: Promise.resolve("codex app-server exited with code 1: not logged in"), kill: () => {} };
};
