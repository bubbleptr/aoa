// Freezes the permission decisions in aoa's store into an offline snapshot for the replay harness (run.ts).
// Opens the database read-only; the snapshot goes under the data directory, never into the repo.
//
//   bun apps/aoa/eval/export.ts [--config <aoa.config.ts>] [--out <dir>]
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Risk } from "@aoa/kernel";
import { DEFAULT_AGENT, type Role, derivePaths, loadConfig } from "../src/config.ts";
import type { ReviewInput } from "../src/reviewer.ts";

/** The tools whose decisions are replayed. Other tools still appear among a call's prior calls. */
export const EXPORTED_TOOLS = new Set(["bash", "git_push", "read", "edit", "write", "grep", "find", "ls", "admit"]);

export type AgentInfo = { name: string; role: Role; mode: "local" | "github"; risk?: Record<string, Risk> };

export type PriorCall = { callId: string; tool: string; args: unknown; decision: string; basis: string; at: number };

export type CallRecord = {
  callId: string;
  sessionId: string;
  inboxId: string;
  agent: AgentInfo;
  tool: string;
  /** For `admit`: the held events, `{ events: [{ id, source, from, thread, text, at }] }`. */
  args: unknown;
  at: number;
  /** The first decision recorded for the call. */
  recorded: { decision: string; basis: string };
  /** The user's answer, when the first decision was a deferral they answered. Never part of `context`. */
  answer: { verdict: string; text?: string; via?: string; at: number; basis: string } | null;
  /** Only what existed before `at`. */
  context: {
    userMessages: { at: number; text: string }[];
    /** Written by another agent (a model), not the user. */
    agentMessages: { at: number; from: string | null; text: string; trusted: boolean }[];
    /** The session's earlier calls with their first decision. Never results, never answers. */
    priorCalls: PriorCall[];
    taintedAsOf: boolean;
    workdirAsOf: string;
  };
  /** Set on synthetic cases only (eval/bad/*.jsonl). */
  label?: "allow" | "ask" | "block";
  category?: string;
};

export type SessionRecord = {
  id: string;
  inboxId: string;
  agent: AgentInfo;
  status: string;
  createdAt: number;
  workdirAsOf: string;
  calls: number;
};

export type ExportOptions = {
  agentOf(inboxId: string): AgentInfo;
  workdirOf(inboxId: string, sessionId: string): string;
};

type EventRow = { id: string; source: string; received_at: number; payload: string; thread: string | null; trusted: number; session_id: string | null };
type DecisionRow = { seq: number; call_id: string; session_id: string; tool: string; decision: string; basis: string; at: number };

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Builds the snapshot from an open store. Reads everything inside one read transaction, so the snapshot is consistent. */
export function buildExport(db: Database, o: ExportOptions): { calls: CallRecord[]; sessions: SessionRecord[]; notes: string[] } {
  return db.transaction(() => build(db, o)).deferred();
}

function build(db: Database, o: ExportOptions): { calls: CallRecord[]; sessions: SessionRecord[]; notes: string[] } {
  const notes: string[] = [];
  const sessions = db.query("SELECT id, inbox_id, status, created_at FROM sessions ORDER BY created_at").all() as {
    id: string;
    inbox_id: string;
    status: string;
    created_at: number;
  }[];
  // An event belongs to the session it resumes; failing that, to the session of the run that took it, or of its thread.
  const events = db
    .query(
      `SELECT e.id, e.source, e.received_at, e.payload, e.thread, e.trusted,
              COALESCE(e.resume, r.session_id, t.session_id) AS session_id
       FROM events e
       LEFT JOIN runs r ON r.id = e.run
       LEFT JOIN threads t ON t.inbox_id = e.inbox_id AND t.thread_key = e.thread
       ORDER BY e.received_at, e.seq`,
    )
    .all() as EventRow[];
  const decisions = db.query("SELECT seq, call_id, session_id, tool, decision, basis, at FROM decisions ORDER BY seq").all() as DecisionRow[];
  const journal = new Map<string, string>();
  for (const j of db.query("SELECT session_id, call_id, args FROM tool_journal").all() as { session_id: string; call_id: string; args: string }[]) {
    journal.set(`${j.session_id}\u0000${j.call_id}`, j.args);
  }

  const answers = new Map<string, EventRow>();
  for (const e of events) {
    if (e.source !== "approval_answer") continue;
    const callId = str(field(parse(e.payload), "callId"));
    if (callId !== undefined && !answers.has(callId)) answers.set(callId, e);
  }

  const eventsOf = new Map<string, EventRow[]>();
  for (const e of events) {
    if (e.session_id === null) continue;
    (eventsOf.get(e.session_id) ?? eventsOf.set(e.session_id, []).get(e.session_id)!).push(e);
  }
  const unattached = events.filter((e) => e.session_id === null).length;
  if (unattached > 0) notes.push(`${unattached} events belong to no session and are left out`);

  // Per call: its first decision, and the decisions after it.
  const byCall = new Map<string, { first: DecisionRow; later: DecisionRow[] }>();
  for (const d of decisions) {
    const key = `${d.session_id}\u0000${d.call_id}`;
    const entry = byCall.get(key);
    if (entry) entry.later.push(d);
    else byCall.set(key, { first: d, later: [] });
  }
  const firsts = [...byCall.values()].map((c) => c.first).sort((a, b) => a.seq - b.seq);

  const heldOf = new Map<string, EventRow[]>();
  const argsOf = (d: DecisionRow): unknown => {
    if (d.tool === "admit") return { events: (heldOf.get(d.call_id) ?? []).map(heldEvent) };
    const raw = journal.get(`${d.session_id}\u0000${d.call_id}`);
    return raw === undefined ? null : parse(raw);
  };
  // An admit holds the session's untrusted events that arrived after its previous admit, up to its own request.
  for (const s of sessions) {
    let since = -Infinity;
    for (const d of firsts.filter((f) => f.session_id === s.id && f.tool === "admit")) {
      const held = (eventsOf.get(s.id) ?? []).filter((e) => e.trusted === 0 && e.received_at > since && e.received_at <= d.at);
      heldOf.set(d.call_id, held);
      if (held.length === 0) notes.push(`admit ${d.call_id}: no held event found`);
      since = d.at;
    }
  }

  const calls: CallRecord[] = [];
  const sessionRecords: SessionRecord[] = [];
  for (const s of sessions) {
    const agent = o.agentOf(s.inbox_id);
    const workdirAsOf = o.workdirOf(s.inbox_id, s.id);
    const own = firsts.filter((f) => f.session_id === s.id);
    const sessionEvents = eventsOf.get(s.id) ?? [];
    sessionRecords.push({ id: s.id, inboxId: s.inbox_id, agent, status: s.status, createdAt: s.created_at, workdirAsOf, calls: 0 });
    for (const d of own) {
      if (!EXPORTED_TOOLS.has(d.tool)) continue;
      const held = new Set((heldOf.get(d.call_id) ?? []).map((e) => e.id));
      const before = sessionEvents.filter((e) => e.received_at < d.at && !held.has(e.id));
      const args = argsOf(d);
      if (args === null) notes.push(`${d.call_id}: no journal args`);
      const entry = byCall.get(`${d.session_id}\u0000${d.call_id}`)!;
      const answerRow = entry.later.find((l) => l.basis.startsWith("user ")) ?? null;
      const answerEvent = answers.get(d.call_id);
      const answerPayload = answerEvent ? parse(answerEvent.payload) : undefined;
      if (d.decision === "defer" && answerRow === null) notes.push(`${d.call_id}: deferred, never answered`);
      calls.push({
        callId: d.call_id,
        sessionId: s.id,
        inboxId: s.inbox_id,
        agent,
        tool: d.tool,
        args,
        at: d.at,
        recorded: { decision: d.decision, basis: d.basis },
        answer:
          answerRow === null
            ? null
            : {
                verdict: str(field(answerPayload, "verdict")) ?? (answerRow.decision === "allow" ? "approve" : "deny"),
                ...(str(field(answerPayload, "text")) === undefined ? {} : { text: str(field(answerPayload, "text"))! }),
                ...(str(field(answerPayload, "via")) === undefined ? {} : { via: str(field(answerPayload, "via"))! }),
                at: answerRow.at,
                basis: answerRow.basis,
              },
        context: {
          userMessages: before
            .filter((e) => e.source === "user_message" && e.trusted === 1)
            .map((e) => ({ at: e.received_at, text: str(field(parse(e.payload), "text")) ?? e.payload })),
          agentMessages: before
            .filter((e) => e.source === "agent_message")
            .map((e) => {
              const p = parse(e.payload);
              return { at: e.received_at, from: str(field(p, "from")) ?? null, text: str(field(p, "text")) ?? e.payload, trusted: e.trusted === 1 };
            }),
          priorCalls: own
            .filter((p) => p.seq < d.seq)
            .map((p) => ({ callId: p.call_id, tool: p.tool, args: argsOf(p), decision: p.decision, basis: p.basis, at: p.at })),
          taintedAsOf: before.some((e) => e.trusted === 0),
          workdirAsOf,
        },
      });
    }
    sessionRecords.at(-1)!.calls = calls.filter((c) => c.sessionId === s.id).length;
  }
  return { calls, sessions: sessionRecords, notes };
}

function heldEvent(e: EventRow) {
  const p = parse(e.payload);
  return {
    id: e.id,
    source: e.source,
    from: str(field(p, "from")) ?? null,
    thread: e.thread,
    text: str(field(p, "text")) ?? e.payload,
    at: e.received_at,
  };
}

/** The `@<name>` of a named agent's inbox; undefined for the default agent. */
export const agentNameOf = (inboxId: string): string | undefined => {
  const at = inboxId.lastIndexOf("@");
  return at < 0 ? undefined : inboxId.slice(at + 1);
};

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const home = homedir();
  const configPath = flag("--config") ?? join(home, ".aoa", "aoa.config.ts");
  const config = await loadConfig(configPath, process.cwd());
  const paths = derivePaths(config, home);
  const out = flag("--out") ?? join(paths.dataDir, "eval", "export");
  const mode = config.github ? "github" : "local";

  const agentOf = (inboxId: string): AgentInfo => {
    const name = agentNameOf(inboxId);
    if (name === undefined) return { name: DEFAULT_AGENT, role: "implement", mode, ...(config.risk ? { risk: config.risk } : {}) };
    const named = config.agents?.[name];
    if (!named) throw new Error(`inbox ${inboxId} names agent ${name}, which the config does not have`);
    const risk = named.risk ?? config.risk;
    return { name, role: named.role, mode, ...(risk ? { risk } : {}) };
  };
  const workdirOf = (inboxId: string, sessionId: string): string =>
    join(derivePaths(config, home, agentNameOf(inboxId)).worktrees, sessionId);

  const db = new Database(paths.db, { readonly: true });
  const { calls, sessions, notes } = buildExport(db, { agentOf, workdirOf });
  db.close();

  const agentsMdPath = join(paths.repo, "AGENTS.md");
  const agentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf8") : null;
  if (agentsMd === null) notes.push("no AGENTS.md in the main checkout");

  // Does the derived working directory show up in the calls' own paths?
  let mentions = 0;
  let other = 0;
  const otherExamples = new Set<string>();
  const worktreeRoot = join(paths.dataDir, "worktrees");
  for (const c of calls) {
    const text = JSON.stringify(c.args);
    if (text.includes(c.context.workdirAsOf)) mentions++;
    for (const m of text.matchAll(new RegExp(`${worktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/"\\s]+/[^/"\\s]+/[0-9a-f-]{36}`, "g"))) {
      if (m[0] !== c.context.workdirAsOf) {
        other++;
        otherExamples.add(`${c.sessionId} -> ${m[0].slice(worktreeRoot.length)}`);
      }
    }
  }
  notes.push(`workdir check: ${mentions}/${calls.length} calls name their derived workdir; ${other} mentions of another session's worktree`);
  for (const e of [...otherExamples].slice(0, 10)) notes.push(`  other worktree: ${e}`);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "calls.jsonl"), calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(out, "sessions.json"), JSON.stringify({ exportedAt: Date.now(), agentsMd, sessions, notes }, null, 2));

  const count = (key: (c: CallRecord) => string) => {
    const m = new Map<string, number>();
    for (const c of calls) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  console.log(`wrote ${calls.length} calls, ${sessions.length} sessions to ${out}`);
  console.log("by tool:", Object.fromEntries(count((c) => c.tool)));
  console.log("by basis:", Object.fromEntries(count((c) => `${c.recorded.decision} ${c.recorded.basis}`)));
  console.log("answered:", Object.fromEntries(count((c) => c.answer?.verdict ?? "none")));
  for (const n of notes) console.log("note:", n);
}

if (import.meta.main) await main();

/** A recorded call as the reviewer would have been shown it then. */
export function reviewInputOf(c: CallRecord): ReviewInput {
  return {
    role: c.agent.role,
    workdir: c.context.workdirAsOf,
    userMessages: c.context.userMessages.map((m) => m.text),
    agentMessages: c.context.agentMessages.map((m) => ({ from: m.from, text: m.text })),
    priorCalls: c.context.priorCalls.map((p) => ({ tool: p.tool, decision: p.decision, args: p.args })),
    tool: c.tool,
    args: c.args,
    tainted: c.context.taintedAsOf,
  };
}
