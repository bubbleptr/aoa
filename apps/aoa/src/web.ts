import { watch as watchFile } from "node:fs";
import { join } from "node:path";
import type { Role } from "./config.ts";
import { type Edge, type Snapshot, changed, flows, snapshot } from "./observe.ts";
import type { Agent } from "./wiring.ts";

export const DEFAULT_WEB_PORT = 7878;
/** Commits come in bursts (intent, result, outbox); one rebuild covers a burst. */
const COALESCE_MS = 50;
/**
 * The safety net for a change the file watch missed; it reads only `data_version`, no tables. fs.watch can drop a
 * write for good (seen on macOS across a burst of commits), so this is not a rare path: one second bounds the staleness.
 */
const VERSION_CHECK_MS = 1_000;

const PAGE = join(import.meta.dir, "web.html");

export type WebOptions = {
  port: number;
  /** Calls `onChange` whenever the store may have changed; returns what stops it. By default, a watch on the WAL file. */
  watch?: (onChange: () => void) => () => void;
};

export type Web = { port: number; stop(): Promise<void> };

/**
 * What `/snapshot` serves and every update carries: the default agent's snapshot, with each named agent's alongside.
 * The page is read from disk per request while `serve` keeps running, so a page from before named agents reads this
 * as the one agent it knows.
 */
export type View = Snapshot & { agents: { name: string; role: Role; snapshot: Snapshot }[] };

type Flows = Partial<Record<Edge, number>>;

/** A view with every `at` zeroed: when it was taken does not make it different. */
const timeless = (v: View) => ({ ...v, agents: v.agents.map((a) => ({ ...a, snapshot: { ...a.snapshot, at: 0 } })) });

/**
 * Watching the WAL file sees every commit from another process within a millisecond; watching its directory misses
 * some. The agent's own connection is open, so the file exists and stays.
 */
const walWatch = (db: string) => (onChange: () => void) => {
  const watcher = watchFile(`${db}-wal`, () => onChange());
  return () => watcher.close();
};

const encoder = new TextEncoder();

/**
 * `aoa web`: a read-only page on 127.0.0.1 that shows the store live. Every client gets the current snapshot on
 * connect, then an update whenever a rebuild finds something different, with what flowed along each edge.
 */
export function startWeb(agent: Agent, o: WebOptions): Web {
  const { clock } = agent;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let current: View;
  let version: number;
  let cancelCoalesce: (() => void) | null = null;
  let cancelFlip = () => {};
  let cancelCheck = () => {};

  const send = (c: ReadableStreamDefaultController<Uint8Array>, update: object) =>
    c.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`));

  /** Snapshots that depend only on time (serve going stale, a retry coming due) need a rebuild with no write. */
  const armFlip = () => {
    cancelFlip();
    const at = current.nextChangeAt;
    cancelFlip = at === null ? () => {} : clock.setTimer(Math.max(0, at - clock.now()), rebuild);
  };

  function build(): View {
    // Read before the tables, so a commit landing in between is caught by the next check.
    version = agent.store.dataVersion();
    const [first, ...named] = agent.agents.map((a) => ({ name: a.name, role: a.role, snapshot: snapshot(a) }));
    const later = [first!.snapshot, ...named.map((a) => a.snapshot)].map((s) => s.nextChangeAt).filter((at) => at !== null);
    return { ...first!.snapshot, agents: named, nextChangeAt: later.length > 0 ? Math.min(...later) : null };
  }

  function rebuild(): void {
    const next = build();
    if (changed(timeless(current), timeless(next))) {
      const flowsByAgent: Record<string, Flows> = {};
      for (const a of next.agents) {
        const before = current.agents.find((b) => b.name === a.name);
        const moved = before ? flows(before.snapshot, a.snapshot) : {};
        if (Object.keys(moved).length > 0) flowsByAgent[a.name] = moved;
      }
      const update = { snapshot: next, flows: flows(current, next), flowsByAgent };
      current = next;
      for (const c of clients) {
        try {
          send(c, update);
        } catch {
          // Its client went away without the stream being cancelled.
          clients.delete(c);
        }
      }
    }
    armFlip();
  }

  const check = () => {
    if (agent.store.dataVersion() !== version) rebuild();
    cancelCheck = clock.setTimer(VERSION_CHECK_MS, check);
  };

  current = build();
  armFlip();
  cancelCheck = clock.setTimer(VERSION_CHECK_MS, check);
  const stopWatch = (o.watch ?? walWatch(agent.paths.db))(() => {
    cancelCoalesce ??= clock.setTimer(COALESCE_MS, () => {
      cancelCoalesce = null;
      rebuild();
    });
  });

  const quiet = () => {
    stopWatch();
    cancelCoalesce?.();
    cancelFlip();
    cancelCheck();
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = listen();
  } catch (err) {
    // serve keeps running without the page; a watch or timer left behind would keep this process alive after it.
    quiet();
    throw err;
  }

  return {
    port: server.port!,
    async stop() {
      quiet();
      for (const c of clients) {
        try {
          c.close();
        } catch {
          // Already closed by its client.
        }
      }
      clients.clear();
      await server.stop(true);
    },
  };

  function listen() {
    return Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    fetch(req, srv) {
      const host = req.headers.get("host");
      // A page on another site that resolves its own name to 127.0.0.1 sends its own Host; it must not read this.
      if (host !== `127.0.0.1:${srv.port}` && host !== `localhost:${srv.port}`) return new Response("Forbidden\n", { status: 403 });
      if (req.method !== "GET") return new Response("Method Not Allowed\n", { status: 405, headers: { allow: "GET" } });
      const { pathname } = new URL(req.url);
      if (pathname === "/") {
        return new Response(Bun.file(PAGE), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (pathname === "/snapshot") return Response.json(current);
      if (pathname === "/events") {
        // An event stream is idle between changes; the server's idle timeout would cut it.
        srv.timeout(req, 0);
        let self: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              self = c;
              clients.add(c);
              send(c, { snapshot: current, flows: {}, flowsByAgent: {} });
            },
            cancel() {
              clients.delete(self);
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } },
        );
      }
      return new Response("Not Found\n", { status: 404 });
    },
  });
  }
}
