import type { Tx } from "@aoa/kernel";
import type { SqliteStore } from "@aoa/store-sqlite";

export type PullRef = { number: number; url: string; thread: string; openedAt: number };

/** The session's pull request: the first successful `github_open_pr` in its journal. */
export function pullOf(t: Tx, sessionId: string): PullRef | null {
  for (const j of t.listJournal(sessionId)) {
    if (j.tool !== "github_open_pr" || j.result?.status !== "ok" || j.resultAt === null) continue;
    const out = j.result.output as { number: number; url: string; thread: string };
    return { number: out.number, url: out.url, thread: out.thread, openedAt: j.resultAt };
  }
  return null;
}

export type Outcome = "merged" | "reworked" | "discarded" | "in progress";

/**
 * Design §10. `pull` is the stored state of the session's pull request: null when it has none,
 * `unknown` when it has one whose state was never looked up.
 */
export function outcome(o: {
  pull: "open" | "merged" | "closed" | "unknown" | null;
  userEventsAfterPull: number;
  sessionClosed: boolean;
}): Outcome {
  if (o.pull === "merged") return o.userEventsAfterPull > 0 ? "reworked" : "merged";
  if (o.pull === "closed" || (o.pull === null && o.sessionClosed)) return "discarded";
  return "in progress";
}

export type SessionStatus = {
  session: string;
  thread: string | null;
  state: "waiting for you" | "open" | "closed";
  outcome: Outcome;
  /** How many of its calls were deferred to the user. */
  asked: number;
  pull: { number: number; url: string; state: "open" | "merged" | "closed" | null } | null;
  timeToPullMs: number | null;
};

export type StatusReport = {
  sessions: SessionStatus[];
  pending: { callId: string; session: string; thread: string | null; tool: string; asks: string }[];
  dead: { id: string; source: string; thread: string | null; attempts: number }[];
  failed: { id: string; kind: string; thread: string | null; attempts: number }[];
};

const ASK_LIMIT = 120;

function asks(tool: string, kind: "approval" | "question", args: unknown): string {
  const text = kind === "question" ? String((args as { question?: unknown }).question) : `${tool} ${JSON.stringify(args)}`;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ASK_LIMIT ? `${line.slice(0, ASK_LIMIT - 1)}…` : line;
}

/** Everything `aoa status` shows, read from the store alone. */
export function collectStatus(store: SqliteStore, inboxId: string): StatusReport {
  return store.tx((t) => {
    const events = t.listEvents(inboxId);
    const sessions = t.listSessions(inboxId).map((s): SessionStatus => {
      const mine = events.filter((e) => e.resume === s.id && e.status !== "dropped");
      const pr = pullOf(t, s.id);
      const stored = store.pulls.get(s.id);
      // A reply that answered a deferred call is the user stepping in too; an expiry is not.
      const userEventsAfterPull = pr
        ? mine.filter(
            (e) =>
              e.trusted &&
              e.receivedAt > pr.openedAt &&
              (e.source === "user_message" || (e.source === "approval_answer" && !(e.payload as { expired?: true }).expired)),
          ).length
        : 0;
      const first = Math.min(...mine.map((e) => e.receivedAt));
      return {
        session: s.id,
        thread: t.primaryThread(s.id),
        state: s.status === "paused" ? "waiting for you" : s.status,
        outcome: outcome({
          pull: pr ? (stored?.state ?? "unknown") : null,
          userEventsAfterPull,
          sessionClosed: s.status === "closed",
        }),
        asked: t.listDecisions(s.id).filter((d) => d.decision === "defer").length,
        pull: pr ? { number: pr.number, url: pr.url, state: stored?.state ?? null } : null,
        timeToPullMs: pr && Number.isFinite(first) ? pr.openedAt - first : null,
      };
    });
    return {
      sessions,
      pending: t.listDeferred(inboxId).map((d) => ({
        callId: d.callId,
        session: d.sessionId,
        thread: t.primaryThread(d.sessionId),
        tool: d.tool,
        asks: asks(d.tool, d.kind, d.args),
      })),
      dead: events
        .filter((e) => e.status === "dead")
        .map((e) => ({ id: e.id, source: e.source, thread: e.thread, attempts: e.attempts })),
      failed: t.listFailed(inboxId).map((m) => ({ id: m.id, kind: m.kind, thread: m.thread, attempts: m.attempts })),
    };
  });
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86_400)}d ${pad(Math.floor((s % 86_400) / 3600))}h`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
}

export function renderStatus(r: StatusReport): string {
  const lines: string[] = [];
  if (r.sessions.length === 0) lines.push("No sessions yet.");
  else {
    lines.push(
      ...table(
        ["SESSION", "THREAD", "STATE", "OUTCOME", "ASKED", "PR", "TIME TO PR"],
        r.sessions.map((s) => [
          s.session.slice(0, 8),
          s.thread ?? "-",
          s.state,
          s.outcome,
          String(s.asked),
          s.pull ? `#${s.pull.number}` : "-",
          s.timeToPullMs === null ? "-" : formatDuration(s.timeToPullMs),
        ]),
      ),
    );
  }
  lines.push("", "Pending approvals:");
  if (r.pending.length === 0) lines.push("  none");
  for (const p of r.pending) lines.push(`  ${p.callId}  on ${p.thread ?? "-"}: ${p.asks}`);
  lines.push("", "Dead events:");
  if (r.dead.length === 0) lines.push("  none");
  for (const d of r.dead) lines.push(`  ${d.id}  ${d.source} on ${d.thread ?? "-"} after ${d.attempts} attempts`);
  lines.push("", "Failed messages:");
  if (r.failed.length === 0) lines.push("  none");
  for (const f of r.failed) lines.push(`  ${f.id}  ${f.kind} to ${f.thread ?? "-"} after ${f.attempts} attempts`);
  return lines.join("\n");
}

/** The pending call an id or a unique prefix of one names. */
export function resolveCallId(callIds: string[], prefix: string): string {
  if (callIds.includes(prefix)) return prefix;
  const matches = callIds.filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  const list = (ids: string[]) => (ids.length === 0 ? "  none" : ids.map((id) => `  ${id}`).join("\n"));
  if (matches.length === 0) throw new Error(`No pending call matches "${prefix}". Pending calls:\n${list(callIds)}`);
  throw new Error(`"${prefix}" is ambiguous; it matches:\n${list(matches)}`);
}
