import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteStore } from "@aoa-dev/sdk";
import { buildExport, type CallRecord } from "../eval/export.ts";

const dir = mkdtempSync(join(tmpdir(), "aoa-eval-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const S = "s-1";
const INBOX = "local/repo";

function fixture(): Database {
  const path = join(dir, "aoa.db");
  sqliteStore(path, { watchFile: false }).close();
  const db = new Database(path);
  db.run(`INSERT INTO sessions (id, inbox_id, status, created_at) VALUES (?, ?, 'closed', 50)`, [S, INBOX]);
  let n = 0;
  const event = (source: string, at: number, trusted: number, payload: object) =>
    db.run(
      `INSERT INTO events (id, inbox_id, source, dedupe_key, received_at, payload, thread, resume, trusted, status)
       VALUES (?, ?, ?, ?, ?, ?, 'local:t', ?, ?, 'done')`,
      [`e${++n}`, INBOX, source, `k${n}`, at, JSON.stringify(payload), S, trusted],
    );
  const call = (id: string, tool: string, args: object, at: number, decision: string, basis: string) => {
    db.run(
      `INSERT INTO tool_journal (session_id, call_id, inbox_id, tool, args, state, intent_at) VALUES (?, ?, ?, ?, ?, 'done', ?)`,
      [S, id, INBOX, tool, JSON.stringify(args), at],
    );
    db.run(`INSERT INTO decisions (call_id, session_id, tool, decision, basis, at) VALUES (?, ?, ?, ?, ?, ?)`, [id, S, tool, decision, basis, at]);
  };

  event("user_message", 100, 1, { kind: "send", text: "first request" });
  call("c1", "bash", { command: "cat ~/.ssh/config" }, 200, "defer", "rule:credential-paths");
  event("user_message", 300, 1, { kind: "send", text: "LATER-USER-MESSAGE" });
  event("approval_answer", 350, 1, { callId: "c1", verdict: "deny", text: "DENY-REASON" });
  db.run(`INSERT INTO decisions (call_id, session_id, tool, decision, basis, at) VALUES ('c1', ?, 'bash', 'block', 'user denied', 360)`, [S]);
  // Trusted on purpose: an agent's message is never the user's, whatever its trust flag says.
  event("agent_message", 380, 1, { from: "default", text: "TRUSTED-AGENT-TEXT" });
  call("c2", "bash", { command: "bun test" }, 390, "allow", "classifier:allow");
  event("agent_message", 400, 0, { from: "reviewer", text: "UNTRUSTED-AGENT-TEXT" });
  call("c3", "bash", { command: "LATER-CALL" }, 500, "allow", "classifier:allow");
  return db;
}

const { calls } = buildExport(fixture(), {
  agentOf: () => ({ name: "default", role: "implement", mode: "local" }),
  workdirOf: (inbox, session) => `/data/worktrees/${inbox}/${session}`,
});
const byId = (id: string): CallRecord => calls.find((c) => c.callId === id)!;

describe("eval export context", () => {
  test("a call's context holds only what came before it", () => {
    const c1 = byId("c1");
    const text = JSON.stringify(c1.context);
    expect(c1.context.userMessages.map((m) => m.text)).toEqual(["first request"]);
    expect(text).not.toContain("LATER-USER-MESSAGE");
    expect(text).not.toContain("LATER-CALL");
    expect(text).not.toContain("DENY-REASON");
    expect(c1.context.priorCalls).toEqual([]);
    // The answer is part of the record, outside the context.
    expect(c1.answer).toMatchObject({ verdict: "deny", text: "DENY-REASON" });
    expect(c1.recorded).toEqual({ decision: "defer", basis: "rule:credential-paths" });
  });

  test("prior calls are the earlier calls with their first decision, never an answer", () => {
    const c2 = byId("c2");
    expect(c2.context.priorCalls.map((p) => [p.callId, p.decision])).toEqual([["c1", "defer"]]);
    expect(JSON.stringify(c2.context)).not.toContain("DENY-REASON");
    expect(JSON.stringify(c2.context)).not.toContain("LATER-CALL");
    expect(byId("c3").context.priorCalls.map((p) => p.callId)).toEqual(["c1", "c2"]);
  });

  test("taintedAsOf flips only after an untrusted event", () => {
    expect(byId("c1").context.taintedAsOf).toBe(false);
    expect(byId("c2").context.taintedAsOf).toBe(false);
    expect(byId("c3").context.taintedAsOf).toBe(true);
  });

  test("an agent_message never lands in userMessages", () => {
    for (const c of calls) {
      expect(JSON.stringify(c.context.userMessages)).not.toContain("AGENT-TEXT");
    }
    expect(byId("c3").context.agentMessages.map((m) => m.text)).toEqual(["TRUSTED-AGENT-TEXT", "UNTRUSTED-AGENT-TEXT"]);
    expect(byId("c3").context.userMessages.map((m) => m.text)).toEqual(["first request", "LATER-USER-MESSAGE"]);
  });

  test("the working directory is derived from the inbox and session", () => {
    expect(byId("c1").context.workdirAsOf).toBe("/data/worktrees/local/repo/s-1");
  });
});
