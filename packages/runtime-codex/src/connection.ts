import type { RequestId } from "./protocol.ts";

/** One `codex app-server` process, as the runtime sees it. Tests hand in a scripted peer instead. */
export type CodexProcess = {
  /** Sends one message; the line break is the caller's. */
  write(line: string): void;
  /** The server's messages, one per line; ends when the process's stdout closes. */
  lines: AsyncIterable<string>;
  /** Resolves once the process has exited, with why, for the run's error. */
  exited: Promise<string>;
  kill(): void;
};

/** Starts the app server for one run, in the session's working directory. */
export type SpawnCodex = (cwd: string) => CodexProcess;

export const spawnAppServer: SpawnCodex = (cwd) => {
  const child = Bun.spawn(["codex", "app-server"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const stderr = (async () => {
    for await (const chunk of decoded(child.stderr)) tail = (tail + chunk).slice(-2000);
  })();
  return {
    write(line) {
      child.stdin.write(line);
      child.stdin.flush();
    },
    lines: splitLines(child.stdout),
    exited: child.exited.then(async (code) => {
      await stderr.catch(() => {});
      return `codex app-server exited with code ${code}${tail.trim() === "" ? "" : `: ${tail.trim()}`}`;
    }),
    kill: () => child.kill(),
  };
};

async function* decoded(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const bytes of stream) yield decoder.decode(bytes, { stream: true });
}

async function* splitLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  let buffered = "";
  for await (const chunk of decoded(stream)) {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (line !== "") yield line;
    }
  }
  if (buffered.trim() !== "") yield buffered.trim();
}

/** A JSON-RPC error the handler of a server request throws to answer it with an error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Handlers = {
  request(method: string, params: unknown): Promise<unknown>;
  notification(method: string, params: unknown): void;
  /** Called right after each reply to a server request is written. */
  replied(): void;
};

/**
 * JSON-RPC over the process's stdio. Every server request gets a reply, an error for one nobody handles, so Codex
 * never waits on this side. When the process goes away every pending request fails, and so does `closed`.
 */
export class Connection {
  private nextId = 1;
  private readonly waiting = new Map<RequestId, { resolve(v: unknown): void; reject(e: Error): void }>();
  /** Rejects once the server's output ends: nothing more can arrive. */
  readonly closed: Promise<never>;

  constructor(
    private readonly proc: CodexProcess,
    private readonly handlers: Handlers,
  ) {
    this.closed = this.read();
    // A run that already ended does not care how the process went away.
    this.closed.catch(() => {});
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const reply = new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    this.send({ id, method, params });
    return Promise.race([reply, this.closed]);
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(message: object): void {
    this.proc.write(`${JSON.stringify(message)}\n`);
  }

  private async read(): Promise<never> {
    for await (const line of this.proc.lines) {
      let m: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method !== undefined && m.id !== undefined) void this.answer(m.id, m.method, m.params);
      else if (m.method !== undefined) this.handlers.notification(m.method, m.params);
      else if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(`codex app-server: ${m.error.message ?? JSON.stringify(m.error)}`));
        else w?.resolve(m.result);
      }
    }
    const error = new Error(await this.proc.exited);
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
    throw error;
  }

  private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      this.send({ id, result: await this.handlers.request(method, params) });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      this.send({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
    this.handlers.replied();
  }
}
