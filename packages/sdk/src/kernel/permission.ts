import { isDeepStrictEqual } from "node:util";
import { DEFER_TTL_MS, deferInTx, expiryTimerId, type AnswerPayload } from "./deferred.ts";
import type { Tx } from "./ports.ts";
import type { ToolContext } from "./tools.ts";
import type { Event, EventId, InboxId, PendingCall, PermissionAsk, SessionId } from "./types.ts";

/**
 * `HarnessRunInput.ask` for an agent whose harness owns its permissions (design §12). The kernel has no rules for the
 * harness's calls: it lets through, once, a call the user approved, and asks the user about anything else.
 */
export async function askPermission(ctx: ToolContext, a: PermissionAsk): Promise<"allow" | "defer"> {
  const { store, clock, inboxId, sessionId, assertAlive } = ctx;
  // Grants hold args as stored JSON, so compare against what storing these args would give back.
  const args: unknown = JSON.parse(JSON.stringify(a.args ?? null));
  assertAlive();
  return store.tx((t) => {
    const now = clock.now();
    const grants = t.listGrants(sessionId);
    // A failed run is retried with the same call ids; the grant this call used then still covers it.
    if (grants.some((g) => g.usedBy === a.callId)) return "allow";
    const grant = grants.find((g) => g.usedBy === null && g.tool === a.tool && isDeepStrictEqual(g.args, args));
    if (grant) {
      t.useGrant(grant.callId, a.callId);
      t.recordDecision({ callId: a.callId, sessionId, tool: a.tool, decision: "allow", basis: `grant:${grant.callId}`, at: now });
      return "allow";
    }
    // The request, its expiry and its answer are all keyed by call id, so a reused id would never reach the user.
    if (t.getJournal(sessionId, a.callId)) throw new Error(`call ${a.callId} was already answered in this session; ask under a new id`);
    if (t.getSession(sessionId)!.pending !== null) return "defer";
    t.recordDecision({ callId: a.callId, sessionId, tool: a.tool, decision: "defer", basis: "harness asked", at: now });
    deferInTx(
      t,
      {
        callId: a.callId,
        sessionId,
        inboxId,
        tool: a.tool,
        args,
        kind: "harness",
        requestedAt: now,
        expiresAt: now + (ctx.deferTtlMs ?? DEFER_TTL_MS),
      },
      a.reason,
    );
    return "defer";
  });
}

const ADMIT = "admit";
const PREVIEW_LIMIT = 200;

type AdmitArgs = { events: EventId[]; from: string; preview: string };

/**
 * Holds an untrusted batch in harness mode (design §12): the session pauses on an `admit` call covering `held`,
 * and the whole group stays pending, pinned to the session so the answer that releases it joins the same group.
 */
export function holdUntrusted(
  t: Tx,
  inboxId: InboxId,
  sessionId: SessionId,
  group: Event[],
  held: Event[],
  now: number,
  ttlMs: number = DEFER_TTL_MS,
): void {
  t.pinEvents(group.map((e) => e.id), sessionId);
  const callId = crypto.randomUUID();
  const args: AdmitArgs = { events: held.map((e) => e.id), from: sourcesOf(held), preview: previewOf(held) };
  t.recordDecision({ callId, sessionId, tool: ADMIT, decision: "defer", basis: "untrusted input", at: now });
  deferInTx(t, { callId, sessionId, inboxId, tool: ADMIT, args, kind: "admit", requestedAt: now, expiresAt: now + ttlMs });
}

/**
 * Applies the answer to an `admit` call before anything is claimed. Approval lets in the events the request
 * covered; a denial or the expiry drops them and the answer, so no run ever sees them. Returns what is left of the group.
 */
export function resolveAdmit(
  t: Tx,
  inboxId: InboxId,
  pending: PendingCall,
  answer: Event,
  group: Event[],
  now: number,
): { group: Event[]; admitted: Set<EventId> } {
  const { callId, sessionId } = pending;
  const a = answer.payload as AnswerPayload;
  const covered = new Set((pending.args as AdmitArgs).events);
  t.deleteDeferred(callId);
  t.setSessionPending(sessionId, null);
  t.cancelFollowUp(expiryTimerId(callId), sessionId);
  const approved = a.verdict === "approve";
  const basis = approved ? "user approved" : a.expired ? "expired" : "user denied";
  t.recordDecision({ callId, sessionId, tool: ADMIT, decision: approved ? "allow" : "block", basis, at: now });
  if (approved) return { group, admitted: covered };

  const dropped = group.filter((e) => e === answer || covered.has(e.id));
  // A dropped row frees its key; consuming it keeps a redelivery from being asked about again.
  for (const e of dropped) t.consumeKey(inboxId, e.source, e.dedupeKey);
  t.dropEvents(dropped.map((e) => e.id));
  return { group: group.filter((e) => !dropped.includes(e)), admitted: new Set() };
}

function sourcesOf(events: Event[]): string {
  const sources = new Set(
    events.map((e) => {
      const from = (e.payload as { from?: unknown } | null)?.from;
      return e.source === "agent_message" && typeof from === "string" ? `agent ${from}` : e.source;
    }),
  );
  const threads = new Set(events.flatMap((e) => (e.thread === null ? [] : [e.thread])));
  return [[...sources].join(", "), ...(threads.size > 0 ? [`on ${[...threads].join(", ")}`] : [])].join(" ");
}

function previewOf(events: Event[]): string {
  const payload = events[0]!.payload;
  const text = (payload as { text?: unknown } | null)?.text;
  const line = (typeof text === "string" ? text : JSON.stringify(payload)).replace(/\s+/g, " ").trim();
  const cut = line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT - 1)}…` : line;
  return events.length > 1 ? `${cut} (and ${events.length - 1} more)` : cut;
}
