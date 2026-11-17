import type { Event, PendingCall, Session, Tx } from "@aoa/kernel";
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

/** GitHub mode: the session's pull request. */
export type PullColumns = {
  pull: { number: number; url: string; state: "open" | "merged" | "closed" | null } | null;
  timeToPullMs: number | null;
};

/** Local mode: the session's branch, which the user merges themself and reports with `aoa close`. */
export type BranchColumns = {
  /** Null for a review agent's session, which works detached and has no branch of its own. */
  branch: string | null;
  /** From the session's first event to its first delivered message. */
  timeToMessageMs: number | null;
};

export type SessionStatus = {
  /** The agent whose inbox holds the session. */
  agent: string;
  session: string;
  thread: string | null;
  state: "waiting for you" | "open" | "closed";
  outcome: Outcome;
  /** How many of its calls were deferred to the user. */
  asked: number;
} & (PullColumns | BranchColumns);

/** The mode's part of a session's status: what its work led to, and the outcome that follows from it. */
export type ModeColumns = (
  t: Tx,
  store: SqliteStore,
  session: Session,
  events: Event[],
) => { outcome: Outcome; columns: PullColumns | BranchColumns };

/** Trusted events after `since` in which the user stepped in; an answer that only expired is not one. */
const userEventsAfter = (events: Event[], since: number): number =>
  events.filter(
    (e) =>
      e.trusted &&
      e.receivedAt > since &&
      (e.source === "user_message" || (e.source === "approval_answer" && !(e.payload as { expired?: true }).expired)),
  ).length;

const firstEventAt = (events: Event[]): number | null => {
  const first = Math.min(...events.map((e) => e.receivedAt));
  return Number.isFinite(first) ? first : null;
};

export const pullColumns: ModeColumns = (t, store, s, events) => {
  const pr = pullOf(t, s.id);
  const stored = store.pulls.get(s.id);
  const first = firstEventAt(events);
  return {
    outcome: outcome({
      pull: pr ? (stored?.state ?? "unknown") : null,
      userEventsAfterPull: pr ? userEventsAfter(events, pr.openedAt) : 0,
      sessionClosed: s.status === "closed",
    }),
    columns: {
      pull: pr ? { number: pr.number, url: pr.url, state: stored?.state ?? null } : null,
      timeToPullMs: pr && first !== null ? pr.openedAt - first : null,
    },
  };
};

/** Local mode; `branchOf` names a session's branch, null for an agent whose sessions have none. */
export const branchColumns = (branchOf: ((sessionId: string) => string) | null): ModeColumns => (_t, store, s, events) => {
  const declared = store.results.get(s.id)?.result;
  const firstMessage = store.firstMessageSentAt(s.id);
  const first = firstEventAt(events);
  const reworked = declared === "merged" && firstMessage !== null && userEventsAfter(events, firstMessage) > 0;
  return {
    outcome: declared === "discarded" ? "discarded" : declared === "merged" ? (reworked ? "reworked" : "merged") : "in progress",
    columns: {
      branch: branchOf === null ? null : branchOf(s.id),
      timeToMessageMs: firstMessage !== null && first !== null ? firstMessage - first : null,
    },
  };
};

/** What runs an agent, and whether aoa or that runtime's harness decides its own tool calls (design §12). */
export type AgentRuntimeRow = { name: string; runtime: "pi" | "codex" | "dsh"; permissionOwner: "kernel" | "harness"; autoReview: boolean };

export type StatusReport = {
  agents: AgentRuntimeRow[];
  sessions: SessionStatus[];
  pending: { agent: string; callId: string; session: string; thread: string | null; tool: string; asks: string }[];
  dead: { agent: string; id: string; source: string; thread: string | null; attempts: number }[];
  failed: { agent: string; id: string; kind: string; thread: string | null; attempts: number }[];
};

const ASK_LIMIT = 120;

export function asks(tool: string, kind: PendingCall["kind"], args: unknown): string {
  const text = kind === "question" ? String((args as { question?: unknown }).question) : `${tool} ${JSON.stringify(args)}`;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ASK_LIMIT ? `${line.slice(0, ASK_LIMIT - 1)}…` : line;
}

/** Everything `aoa status` shows of one agent's inbox, read from the store alone. */
export function collectStatus(store: SqliteStore, agent: string, inboxId: string, mode: ModeColumns): Omit<StatusReport, "agents"> {
  return store.tx((t) => {
    const events = t.listEvents(inboxId);
    const sessions = t.listSessions(inboxId).map((s): SessionStatus => {
      const mine = events.filter((e) => e.resume === s.id && e.status !== "dropped");
      const { outcome, columns } = mode(t, store, s, mine);
      return {
        agent,
        session: s.id,
        thread: t.primaryThread(s.id),
        state: s.status === "paused" ? "waiting for you" : s.status,
        outcome,
        asked: t.listDecisions(s.id).filter((d) => d.decision === "defer").length,
        ...columns,
      };
    });
    return {
      sessions,
      pending: t.listDeferred(inboxId).map((d) => ({
        agent,
        callId: d.callId,
        session: d.sessionId,
        thread: t.primaryThread(d.sessionId),
        tool: d.tool,
        asks: asks(d.tool, d.kind, d.args),
      })),
      dead: events
        .filter((e) => e.status === "dead")
        .map((e) => ({ agent, id: e.id, source: e.source, thread: e.thread, attempts: e.attempts })),
      failed: t.listFailed(inboxId).map((m) => ({ agent, id: m.id, kind: m.kind, thread: m.thread, attempts: m.attempts })),
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

/** With `agents`, every row names its agent; a single agent's rows read as they always have. */
export function renderStatus(r: StatusReport, o: { agents: boolean } = { agents: false }): string {
  const lines: string[] = [];
  const by = (agent: string) => (o.agents ? `${agent}: ` : "");
  if (r.sessions.length === 0) lines.push("No sessions yet.");
  else {
    const duration = (ms: number | null) => (ms === null ? "-" : formatDuration(ms));
    const local = "branch" in r.sessions[0]!;
    lines.push(
      ...table(
        [
          ...(o.agents ? ["AGENT"] : []),
          "SESSION",
          "THREAD",
          "STATE",
          "OUTCOME",
          "ASKED",
          ...(local ? ["BRANCH", "TIME TO MESSAGE"] : ["PR", "TIME TO PR"]),
        ],
        r.sessions.map((s) => [
          ...(o.agents ? [s.agent] : []),
          s.session.slice(0, 8),
          s.thread ?? "-",
          s.state,
          s.outcome,
          String(s.asked),
          ...("branch" in s
            ? [s.branch ?? "-", duration(s.timeToMessageMs)]
            : [s.pull ? `#${s.pull.number}` : "-", duration(s.timeToPullMs)]),
        ]),
      ),
    );
  }
  lines.push("", "Agents:");
  lines.push(
    ...table(
      ["NAME", "RUNTIME", "PERMISSIONS"],
      r.agents.map((a) => [
        a.name,
        a.runtime,
        permissionText(a),
      ]),
    ).map((l) => `  ${l}`),
  );
  lines.push("", "Pending approvals:");
  if (r.pending.length === 0) lines.push("  none");
  for (const p of r.pending) lines.push(`  ${p.callId}  ${by(p.agent)}on ${p.thread ?? "-"}: ${p.asks}`);
  lines.push("", "Dead events:");
  if (r.dead.length === 0) lines.push("  none");
  for (const d of r.dead) lines.push(`  ${d.id}  ${by(d.agent)}${d.source} on ${d.thread ?? "-"} after ${d.attempts} attempts`);
  lines.push("", "Failed messages:");
  if (r.failed.length === 0) lines.push("  none");
  for (const f of r.failed) lines.push(`  ${f.id}  ${by(f.agent)}${f.kind} to ${f.thread ?? "-"} after ${f.attempts} attempts`);
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

const permissionText = (a: AgentRuntimeRow): string =>
  a.permissionOwner === "kernel"
    ? "aoa decides every tool call"
    : a.runtime === "dsh"
      ? "dsh decides its own tools; aoa relays what it asks"
      : a.autoReview
        ? "Codex decides its own tools; its auto review answers what it asks"
        : "Codex decides its own tools; aoa relays what it asks";
