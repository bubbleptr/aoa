export type InboxId = string;
export type EventId = string;
export type SessionId = string;
export type RunId = string;
export type CallId = string;
export type MsgId = string;
export type TimerId = string;

/** `agent_message`: another agent of the same process wrote it (design §12); trusted only while its sender is untainted. */
export type EventSource = "user_message" | "webhook" | "timer" | "background_job" | "approval_answer" | "agent_message";

export type EventStatus = "pending" | "in_run" | "done" | "dropped" | "dead";

export type Event = {
  id: EventId;
  inboxId: InboxId;
  source: EventSource;
  dedupeKey: string;
  receivedAt: number;
  payload: unknown;
  thread: string | null;
  resume: SessionId | null;
  trusted: boolean;
  status: EventStatus;
  leaseUntil: number | null;
  attempts: number;
  /** A failed attempt's events wait until then before another claim (design §9). */
  nextAttemptAt: number;
  run: RunId | null;
};

export type NewEvent = {
  source: EventSource;
  dedupeKey: string;
  payload: unknown;
  /** External conversation key, e.g. `github:owner/repo#12`; maps the event back to its session. */
  thread?: string;
  /** Whether the content comes from the user rather than an external party (design §6). */
  trusted: boolean;
};

export type SessionStatus = "open" | "paused" | "closed";

export type Session = {
  id: SessionId;
  inboxId: InboxId;
  status: SessionStatus;
  pending: CallId | null;
  runtimeRef: string | null;
  workdir: string | null;
  lastRun: RunId | null;
  createdAt: number;
  /** Set once any run of the session has taken an untrusted event; it never clears (design §6). */
  tainted: boolean;
};

export type RunEnd =
  | { kind: "sent"; msgs: MsgId[] }
  | { kind: "silent" }
  | { kind: "deferred"; callId: CallId };

export type RunRecord = {
  id: RunId;
  inboxId: InboxId;
  sessionId: SessionId;
  events: EventId[];
  startedAt: number;
  endedAt: number | null;
  end: RunEnd | null;
  error: string | null;
};

export type ToolResult =
  | { status: "ok"; output: unknown }
  | { status: "error"; error: string }
  /** The call may have run before a crash and its result was never recorded; check before acting again. */
  | { status: "unknown"; message: string }
  /** The call waits for the user. The runtime must stop the loop and end the run as `deferred` with this call id. */
  | { status: "deferred" };

export type JournalEntry = {
  sessionId: SessionId;
  callId: CallId;
  tool: string;
  args: unknown;
  state: "intent" | "done";
  result: ToolResult | null;
};

/** A tool as registered with the kernel. */
export type ToolDef = {
  name: string;
  description: string;
  schema: unknown;
  /** Safe to execute again when a crash left its outcome unknown (it carries its own idempotency key). */
  idempotent?: boolean;
  execute(args: unknown, ctx: ToolExecContext): Promise<unknown>;
};

/** What a tool's `execute` learns about the call it serves. */
export type ToolExecContext = {
  sessionId: SessionId;
  callId: CallId;
  /** The session's working directory (for a coding task, its worktree), if it has one. */
  workdir: string | null;
};

/** A tool as handed to the runtime: every call goes through the kernel's journal. */
export type Tool = {
  name: string;
  description: string;
  schema: unknown;
  invoke(callId: CallId, args: unknown): Promise<ToolResult>;
};

export type RunInput = {
  runId: RunId;
  session: { id: SessionId; resumed: boolean; ref: string | null; workdir: string | null };
  events: Event[];
  resident: string;
  tools: Tool[];
  /**
   * Set when this run resumes a session that stopped on a deferred call. On `approve` the kernel has
   * already executed the call and `result` holds its outcome; the runtime tells the model, it does not call again.
   * The exception is a call the harness asked about through `ask`: the kernel ran nothing and granted it, and
   * `result` tells the model to make the same call again, which `ask` then allows once.
   */
  answer?: { callId: CallId; tool: string; args: unknown; verdict: "approve" | "deny"; text?: string; result?: ToolResult };
  /**
   * Set only for an agent whose permissions belong to its harness (design §12): the runtime calls it when the
   * harness asks permission for one of its own calls. `allow` means the user approved this exact call earlier;
   * `defer` means the user has been asked (or the session already waits on a call): the runtime must end the run
   * as `deferred`, and the verdict comes back as `answer` in a later run.
   */
  ask?: (request: PermissionAsk) => Promise<"allow" | "defer">;
};

/** A harness's request for permission to make one of its own calls. */
export type PermissionAsk = { callId: CallId; tool: string; args: unknown; reason?: string };

export type RunResult = { end: RunEnd; sessionRef?: string };

export type TimerKind = "follow_up" | "schedule";

export type TimerStatus = "armed" | "done" | "cancelled";

/** Fixed-interval recurrence: occurrences sit on the grid `anchor + k * everyMs`. */
export type Recurrence = { everyMs: number; anchor: number };

/** A row of `timers` (spec §4.2). `kind = "schedule"` iff `recurrence` is set. */
export type Timer = {
  id: TimerId;
  inboxId: InboxId;
  kind: TimerKind;
  /** The session its event resumes; null means the event opens a new session. */
  sessionId: SessionId | null;
  due: number;
  recurrence: Recurrence | null;
  payload: unknown;
  status: TimerStatus;
  lastFired: number | null;
};

export type Decision = "allow" | "block" | "defer";

/**
 * A row of `deferred` (spec §6.2 `PendingCall`). A `question` is an `ask_user` call: the answer is its result.
 * A `harness` call is one the agent's harness asked permission for; approving it grants it, the kernel runs nothing.
 * An `admit` holds a batch of untrusted events until the user lets the agent read them (design §12).
 */
export type PendingCall = {
  callId: CallId;
  sessionId: SessionId;
  inboxId: InboxId;
  tool: string;
  args: unknown;
  kind: "approval" | "question" | "harness" | "admit";
  requestedAt: number;
  expiresAt: number;
};

/** The user's approval of one harness call: it lets an equal call (same tool, deep-equal args) through once. */
export type Grant = {
  /** The approved call. */
  callId: CallId;
  sessionId: SessionId;
  tool: string;
  args: unknown;
  grantedAt: number;
  /** The call that used the grant; null while it is unused. */
  usedBy: CallId | null;
};

/** A row of `decisions` (I-PRM-7). `basis` names the rule, risk tier, classifier verdict or answer behind it. */
export type DecisionRecord = {
  callId: CallId;
  sessionId: SessionId;
  tool: string;
  decision: Decision;
  basis: string;
  at: number;
};

/** A shadow judge's score for one classifier call (design §12). `p` is null when the judge failed. */
export type Judgment = {
  callId: CallId;
  sessionId: SessionId;
  /** The model that answered, as its response named it. */
  model: string;
  /** The probability of yes, 0 to 1; null on failure. */
  p: number | null;
  latencyMs: number;
  /** Why the judge failed; null on success. */
  error: string | null;
  at: number;
};
