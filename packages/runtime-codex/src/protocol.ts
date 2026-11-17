/**
 * The part of the Codex app-server protocol this runtime speaks, written by hand from the bindings that
 * `codex app-server generate-ts --experimental` prints for Codex 0.154.0. Fields this runtime never reads are left out.
 * Messages are JSON-RPC without the `jsonrpc` field, one per line.
 */

export type RequestId = string | number;

export type InitializeParams = {
  clientInfo: { name: string; title: string | null; version: string };
  /** `experimentalApi` is what lets `thread/start` take `dynamicTools`. */
  capabilities: { experimentalApi: boolean; requestAttestation: boolean };
};

export type DynamicToolSpec = { type: "function"; name: string; description: string; inputSchema: unknown };

/** Set only for a read-only agent; otherwise the user's Codex configuration decides both. */
type Confinement = { sandbox?: "read-only"; approvalPolicy?: "never" };

export type ThreadStartParams = {
  cwd: string;
  developerInstructions: string;
  model?: string;
  dynamicTools: DynamicToolSpec[];
} & Confinement;

/** Codex keeps a thread's dynamic tools with the thread, so resuming does not offer them again. */
export type ThreadResumeParams = { threadId: string; cwd: string; developerInstructions: string; model?: string } & Confinement;

export type ThreadResponse = { thread: { id: string } };

export type UserInput = { type: "text"; text: string; text_elements: [] };

export type TurnStartParams = { threadId: string; input: UserInput[] };

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type Turn = { id: string; status: TurnStatus; error: { message: string } | null };

export type TurnStartResponse = { turn: Turn };

export type TurnInterruptParams = { threadId: string; turnId: string };

export type TurnCompletedNotification = { threadId: string; turn: Turn };

export type FileUpdateChange = { path: string; kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null }; diff: string };

/** `item/started` and `item/completed`; only file changes matter here. */
export type ItemNotification = { threadId: string; turnId: string; item: { type: string; id: string; changes?: FileUpdateChange[] } };

export type FileChangePatchUpdatedNotification = { threadId: string; turnId: string; itemId: string; changes: FileUpdateChange[] };

export type CommandExecutionRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  /** Distinct per callback when one item asks more than once. */
  approvalId?: string | null;
  kind: "command" | "writeStdin";
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  networkApprovalContext?: unknown;
  additionalPermissions?: unknown;
};

export type FileChangeRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
};

export type PermissionProfile = { network?: unknown; fileSystem?: unknown };

export type PermissionsRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: { network: unknown | null; fileSystem: unknown | null };
};

/** Never `acceptForSession`: every call the user approved is approved once. */
export type ApprovalDecision = "accept" | "decline";

export type PermissionsRequestApprovalResponse = { permissions: PermissionProfile; scope: "turn" };

export type DynamicToolCallParams = { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: unknown };

export type DynamicToolCallResponse = { contentItems: { type: "inputText"; text: string }[]; success: boolean };

export type ToolRequestUserInputParams = { threadId: string; turnId: string; itemId: string; questions: { id: string }[] };

export type ToolRequestUserInputResponse = { answers: Record<string, { answers: string[] }> };

export type McpServerElicitationRequestResponse = { action: "decline"; content: null; _meta: null };
