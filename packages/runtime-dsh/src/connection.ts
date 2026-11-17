import type { RequestId } from "./protocol.ts";

/** One `dsh` process, as the runtime sees it. Tests hand in a scripted peer instead. */
export type DshProcess = {
  /** Sends one message; the line break is the caller's. */
  write(line: string): void;
  /** The server's messages, one per line; ends when the process's stdout closes. */
  lines: AsyncIterable<string>;
  /** Resolves once the process has exited, with why, for the run's error. */
  exited: Promise<string>;
  /** Ends the process. `SIGTERM` first, `SIGKILL` if it does not go. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

/** Everything the child process needs: the command, what the patch adds, and nothing else of aoa's. */
export type DshLaunch = { command: string; args: string[]; cwd: string; env: Record<string, string> };

/** Starts dsh; tests hand in a scripted one, so no real harness or network is involved. */
export type DshSpawn = {
  /** The version `<command> --version` prints; rejects if the command cannot run. */
  version(command: string): Promise<string>;
  /** Starts one harness process for a run. */
  spawn(launch: DshLaunch): DshProcess | Promise<DshProcess>;
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

const tail = (text: string) => (text.trim() === "" ? "" : `: ${text.trim().slice(-2000)}`);

export const spawnDsh: DshSpawn = {
  async version(command) {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([command, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      throw new Error(`could not run ${command} --version: ${err instanceof Error ? err.message : String(err)}`);
    }
    const out = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const err = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const [stdout, stderr, code] = await Promise.all([out, err, proc.exited]);
    return code === 0 ? stdout : Promise.reject(new Error(`${command} --version exited with code ${code}${tail(stderr)}`));

  },

  spawn(launch) {
    const child = Bun.spawn([launch.command, ...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let err = "";
    const stderr = (async () => {
      for await (const chunk of decoded(child.stderr)) err = (err + chunk).slice(-2000);
    })();
    return {
      write(line) {
        child.stdin.write(line);
        child.stdin.flush();
      },
      lines: splitLines(child.stdout),
      exited: child.exited.then(async (code) => {
        await stderr.catch(() => {});
        return `dsh exited with code ${code}${tail(err)}`;
      }),
      kill: (signal) => void child.kill(signal),
    };
  },
};

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
 * JSON-RPC 2.0 over the process's stdio, as dsh's `JsonRpcLineTransport` frames it. Every server request
 * gets a reply, an error for one nobody handles, so dsh never waits on this side. When the process goes
 * away every pending request fails, and so does `closed`.
 */
export class Connection {
  private nextId = 1;
  private readonly waiting = new Map<RequestId, { resolve(v: unknown): void; reject(e: Error): void }>();
  /** Rejects once the server's output ends: nothing more can arrive. */
  readonly closed: Promise<never>;

  constructor(
    private readonly proc: DshProcess,
    private readonly handlers: Handlers,
  ) {
    this.closed = this.read();
    // A run that already ended does not care how the process went away.
    this.closed.catch(() => {});
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const reply = new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    this.send(params === undefined ? { id, method } : { id, method, params });
    return Promise.race([reply, this.closed]);
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(message: object): void {
    this.proc.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private async read(): Promise<never> {
    for await (const line of this.proc.lines) {
      let m: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method !== undefined && m.id !== undefined) void this.answer(m.id, m.method, m.params);
      else if (m.method !== undefined) this.notified(m.method, m.params);
      else if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.reject(new Error(`dsh: ${m.error.message ?? JSON.stringify(m.error)}`));
        else w?.resolve(m.result);
      }
    }
    const error = new Error(await this.proc.exited);
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
    throw error;
  }

  /** A notification nobody can handle is dropped; it must not stop the reader. */
  private notified(method: string, params: unknown): void {
    try {
      this.handlers.notification(method, params);
    } catch {}
  }

  /**
   * Nothing here may reject: it runs detached from the reader, in a process that serves every agent. A reply
   * that cannot be written means the process is gone, which `closed` reports.
   */
  private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
    let reply: object;
    try {
      reply = { id, result: await this.handlers.request(method, params) };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      reply = { id, error: { code, message: err instanceof Error ? err.message : String(err) } };
    }
    try {
      this.send(reply);
      this.handlers.replied();
    } catch {}
  }
}
