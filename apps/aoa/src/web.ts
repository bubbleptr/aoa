import { watch as watchFile } from "node:fs";
import { join } from "node:path";
import { answerDeferred } from "@aoa/kernel";
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
export type View = Snapshot &
  RuntimeOf & { agents: ({ name: string; role: Role; snapshot: Snapshot } & RuntimeOf)[] };

/** What runs the agent and who decides its own tool calls; a page from before this field shows neither. */
type RuntimeOf = { runtime: Agent["runtime"]; permissionOwner: Agent["permissions"] };

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

/** The longest reason or answer the page may send; a question's answer is a line or a paragraph, not a file. */
const ANSWER_TEXT_LIMIT = 4_000;

const plain = (status: number, text: string) =>
  new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });

/**
 * Answers a waiting call from the page: the same `approval_answer` the CLI writes, marked `via: "web"`. Only a full id
 * of a call that waits now is taken (no prefixes: the page always has the whole id), and an answer the store drops as
 * a second one for that call is reported as a conflict rather than accepted.
 */
function answerFromPage(agent: Agent, body: unknown): Response {
  if (typeof body !== "object" || body === null) return plain(400, "The body must be a JSON object.");
  const { callId, verdict, text } = body as Record<string, unknown>;
  if (typeof callId !== "string" || callId === "") return plain(400, "callId must be a call id.");
  if (verdict !== "approve" && verdict !== "deny") return plain(400, "verdict must be approve or deny.");
  if (text !== undefined && (typeof text !== "string" || text.length > ANSWER_TEXT_LIMIT)) {
    return plain(400, `text must be a string of at most ${ANSWER_TEXT_LIMIT} characters.`);
  }
  const reason = typeof text === "string" && text.trim() !== "" ? text : undefined;
  const pending = agent.store.tx((t) => agent.agents.flatMap((a) => t.listDeferred(a.inboxId))).find((d) => d.callId === callId);
  if (!pending) return plain(404, `No call ${callId} is waiting for an answer.`);
  if (pending.kind === "question" && verdict === "approve" && reason === undefined) return plain(400, "A question needs its answer as text.");
  let result;
  try {
    result = answerDeferred(agent.store, agent.clock, pending.inboxId, callId, verdict, reason, "web");
  } catch (err) {
    // The call was answered and taken between the read above and this write.
    return plain(409, err instanceof Error ? err.message : String(err));
  }
  if (result.status === "dropped") return plain(409, `Call ${callId} already has an answer waiting for the agent.`);
  for (const a of agent.agents) if (a.inboxId === pending.inboxId) a.worker.wake();
  return Response.json({ callId, verdict });
}

/**
 * `aoa web`: a page on 127.0.0.1 that shows the store live, and answers waiting calls. Every client gets the current
 * snapshot on connect, then an update whenever a rebuild finds something different, with what flowed along each edge.
 * The one write is `POST /answer`, taken only from the page itself (see `listen`).
 */
export function startWeb(agent: Agent, o: WebOptions): Web {
  const { clock } = agent;
  /** Each open stream, with what forgets it: it counted toward `page.notifying` if its page notifies. */
  const clients = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
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
    const [first, ...named] = agent.agents.map((a) => ({
      name: a.name,
      role: a.role,
      runtime: a.runtime,
      permissionOwner: a.permissions,
      snapshot: snapshot(a),
    }));
    const later = [first!.snapshot, ...named.map((a) => a.snapshot)].map((s) => s.nextChangeAt).filter((at) => at !== null);
    return {
      ...first!.snapshot,
      runtime: first!.runtime,
      permissionOwner: first!.permissionOwner,
      agents: named,
      nextChangeAt: later.length > 0 ? Math.min(...later) : null,
    };
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
      for (const [c, forget] of clients) {
        try {
          send(c, update);
        } catch {
          // Its client went away without the stream being cancelled.
          forget();
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

  agent.page.url = `http://127.0.0.1:${server.port}`;
  agent.page.notifying = 0;

  return {
    port: server.port!,
    async stop() {
      quiet();
      agent.page.url = null;
      agent.page.notifying = 0;
      for (const c of clients.keys()) {
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
      const { pathname } = new URL(req.url);
      if (pathname === "/answer" && req.method === "POST") {
        // A browser always sends Origin on a POST from script. Only the page's own origin may write: another site,
        // or another server on this machine, gets nothing. JSON forces a preflight, which gets no CORS headers.
        const origin = req.headers.get("origin");
        if (origin !== `http://127.0.0.1:${srv.port}` && origin !== `http://localhost:${srv.port}`) return plain(403, "Forbidden");
        if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return plain(415, "Send JSON.");
        return req.json().then(
          (body) => {
            const res = answerFromPage(agent, body);
            // Its own write: every open page sees the answer queued now, not when the watch fires.
            if (res.ok) rebuild();
            return res;
          },
          () => plain(400, "The body is not JSON."),
        );
      }
      if (req.method !== "GET") return new Response("Method Not Allowed\n", { status: 405, headers: { allow: "GET" } });
      if (pathname === "/") {
        return new Response(Bun.file(PAGE), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (pathname === "/snapshot") return Response.json(current);
      if (pathname === "/events") {
        // An event stream is idle between changes; the server's idle timeout would cut it.
        srv.timeout(req, 0);
        // A page that shows notifications itself says so; while one is open, approvals skip the desktop notification.
        const notifies = new URL(req.url).searchParams.get("notify") === "1";
        let self: ReadableStreamDefaultController<Uint8Array>;
        let open = true;
        const forget = () => {
          if (!open) return;
          open = false;
          clients.delete(self);
          if (notifies) agent.page.notifying--;
        };
        // A closed tab aborts the request at once; the stream itself only notices on its next write.
        req.signal.addEventListener("abort", forget);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              self = c;
              clients.set(c, forget);
              if (notifies) agent.page.notifying++;
              send(c, { snapshot: current, flows: {}, flowsByAgent: {} });
            },
            cancel: forget,
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } },
        );
      }
      return new Response("Not Found\n", { status: 404 });
    },
  });
  }
}
