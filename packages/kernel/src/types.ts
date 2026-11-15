export type InboxId = string;
export type EventId = string;
export type SessionId = string;
export type RunId = string;
export type CallId = string;
export type MsgId = string;
export type TimerId = string;

export type EventSource = "user_message" | "webhook" | "timer" | "background_job" | "approval_answer";

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
   */
  answer?: { callId: CallId; tool: string; args: unknown; verdict: "approve" | "deny"; text?: string; result?: ToolResult };
};

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
