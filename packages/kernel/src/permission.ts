import { isDeepStrictEqual } from "node:util";
import { DEFER_TTL_MS, deferInTx } from "./deferred.ts";
import type { ToolContext } from "./tools.ts";
import type { PermissionAsk } from "./types.ts";

/**
 * `RunInput.ask` for an agent whose harness owns its permissions (design §12). The kernel has no rules for the
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
      { callId: a.callId, sessionId, inboxId, tool: a.tool, args, kind: "harness", requestedAt: now, expiresAt: now + DEFER_TTL_MS },
      a.reason,
    );
    return "defer";
  });
}
