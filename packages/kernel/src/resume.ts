import { answerCallId, expiryTimerId, type AnswerPayload } from "./deferred.ts";
import { UNKNOWN_OUTCOME, executeRecorded, type ToolContext } from "./tools.ts";
import type { Decision, Event, PendingCall, RunInput, ToolDef, ToolResult } from "./types.ts";

/** Whether `e` answers the call a paused session waits on (a reply, a CLI answer or the expiry). */
export const answers = (e: Event, callId: string | null): boolean =>
  e.source === "approval_answer" && callId !== null && answerCallId(e.payload) === callId;

/**
 * Applies the answer in this batch before the run starts (design §6, "批准之后谁执行"): an approved call is
 * executed by the kernel through the journal under its own call id, a question takes the reply as its result,
 * a denial is journaled as the call's result. Then the session reopens.
 *
 * The answer handed to the runtime is rebuilt from the journal, so a retry after a crash anywhere in here
 * gets the same answer and never executes the call a second time.
 */
export async function resolveAnswer(events: Event[], tools: ToolDef[], ctx: ToolContext): Promise<RunInput["answer"]> {
  const { store, sessionId } = ctx;
  const event = events.findLast((e) => e.source === "approval_answer");
  if (!event) return undefined;
  const answer = event.payload as AnswerPayload;

  const pending = store.tx((t) =>
    t.getSession(sessionId)!.pending === answer.callId ? t.getDeferred(answer.callId) : null,
  );
  if (pending) {
    await settle(pending, answer, tools, ctx);
    ctx.assertAlive();
    store.tx((t) => {
      t.deleteDeferred(pending.callId);
      t.setSessionPending(sessionId, null);
      t.cancelFollowUp(expiryTimerId(pending.callId), sessionId);
    });
  }

  const journal = store.tx((t) => t.getJournal(sessionId, answer.callId));
  if (!journal) return undefined;
  return {
    callId: answer.callId,
    tool: journal.tool,
    args: journal.args,
    verdict: answer.verdict,
    ...(answer.text === undefined ? {} : { text: answer.text }),
    ...(answer.verdict === "approve" ? { result: journal.result ?? UNKNOWN_OUTCOME } : {}),
  };
}

async function settle(d: PendingCall, a: AnswerPayload, tools: ToolDef[], ctx: ToolContext): Promise<void> {
  const { store, clock, inboxId, sessionId } = ctx;
  const prior = store.tx((t) => t.getJournal(sessionId, d.callId));
  if (prior?.result) return;

  const record = (decision: Decision, basis: string, result?: ToolResult, grant = false) =>
    store.tx((t) => {
      const now = clock.now();
      t.recordDecision({ callId: d.callId, sessionId, tool: d.tool, decision, basis, at: now });
      t.recordIntent({ inboxId, sessionId, callId: d.callId, tool: d.tool, args: d.args, at: now });
      if (result) t.recordResult(sessionId, d.callId, result, now);
      if (grant) t.insertGrant({ callId: d.callId, sessionId, tool: d.tool, args: d.args, grantedAt: now });
    });

  if (d.kind === "question") {
    if (a.verdict === "approve") record("allow", "user answered", { status: "ok", output: a.text ?? "" });
    else record("block", "user declined", { status: "error", error: `The user declined to answer${because(a.text)}` });
    return;
  }
  if (a.verdict === "deny") {
    const error = a.expired
      ? `${a.text} The call was not executed.`
      : `Denied by the user${because(a.text)} The call was not executed.`;
    record("block", a.expired ? "expired" : "user denied", { status: "error", error });
    return;
  }
  // The kernel cannot run a harness's tools, so approving grants the call and the harness makes it itself.
  if (d.kind === "harness") {
    record("allow", "user approved", { status: "ok", output: HARNESS_APPROVED }, true);
    return;
  }

  const def = tools.find((t) => t.name === d.tool);
  if (!def) {
    record("block", "user approved", { status: "error", error: `Tool ${d.tool} is no longer registered; the call was not executed.` });
    return;
  }
  if (prior) {
    // A crash interrupted the approved execution; only a tool that can safely run again is retried.
    if (def.idempotent) await executeRecorded(def, ctx, d.callId, d.args);
    return;
  }
  record("allow", "user approved");
  await executeRecorded(def, ctx, d.callId, d.args);
}

const HARNESS_APPROVED =
  "The user approved this call, but it has not run yet. Make the same call again with the same arguments; it will be allowed once.";

const because = (text: string | undefined): string => (text ? `: ${text}.` : ".");
