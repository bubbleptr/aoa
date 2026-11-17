/**
 * The patch aoa layered over dsh's `sdk` profile for every run: what aoa turns off, and the two rows it
 * adds. Row ids and the patch dialect are copied from `packages/bundle/base/cordis.patch.yml` and
 * `packages/bundle/sdk-app/cordis.patch.yml` of dsh 0.2.2-rc.3 (docs/proposals/deepseek-harness.md §5).
 */

/** The dsh release aoa was written and tested against; dsh's handshake version is a fixed `0.0.1`, so this is read from `--version`. */
export const DSH_VERSION = "0.2.2-rc.3";

/** The dsh profile aoa runs: stdio JSON-RPC, nothing else on stdout. */
export const DSH_PROFILE = "sdk";

/** dsh's own permission presets, from its `permission` row: what the sandbox allows and when it asks. */
export const PERMISSION_PRESETS = {
  "read-only": { sandbox: "read-only", approval: "ask" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask" },
  "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
} as const;

export type PermissionPreset = keyof typeof PERMISSION_PRESETS;

/** The MCP server name aoa's tools are bridged under; dsh shows them as `mcp__aoa__<tool>`. */
export const MCP_SERVER_NAME = "aoa";

/** The prefix dsh puts in front of a bridged tool's name. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * dsh's own capabilities that aoa does not use, disabled one row at a time: subagents and teams, goals,
 * workflow and PTC programs, background jobs, the plugin manager, and dsh's own question and schedule
 * tools. An isolated home does not remove them, and the ask/schedule tools would compete with aoa's
 * `ask_user` and `wake_me_at`.
 */
export const DISABLED_ROWS = [
  "subagent",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "agent-team",
  "tool-agent-team",
  "tool-subagent",
  "tool-subagent-control",
  "tool-subagent-fork",
  "goal",
  "goal-round-driver",
  "command-goal",
  "tool-goal",
  "workflow-ptc",
  "tool-workflow",
  "jobs",
  "tool-jobs",
  "plugin-manager",
  "tool-plugin-manager",
  "tool-ask-user",
  "tool-schedule",
] as const;

/**
 * The patch file, as YAML. aoa's system prompt goes in through `personaSuffix` (the SDK protocol has no
 * instructions field); the value itself travels in the child's environment, so no prompt text has to be
 * escaped into YAML. The permission preset is written as the sandbox mode and approval policy dsh's own
 * `permission` row names, so the user's dsh settings cannot widen it. The MCP row points dsh at this
 * run's bridge, token and all.
 */
export function patchYaml(o: { url: string; preset: PermissionPreset }): string {
  const permission = PERMISSION_PRESETS[o.preset];
  const lines = [
    "# Written by aoa for one run: the capabilities aoa turns off, the permission preset, and the bridge to aoa's own tools.",
    "- id: system-prompt",
    "  config:",
    "    personaSuffix: !!js process.env.AOA_DSH_SYSTEM_PROMPT",
    "- id: sandbox-policy",
    "  config:",
    `    mode: ${permission.sandbox}`,
    "    workspaceRoot: !!js process.cwd()",
    "- id: approval",
    "  config:",
    `    policy: ${permission.approval}`,
    ...DISABLED_ROWS.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
    "- insert:",
    "    - id: aoa-mcp",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${MCP_SERVER_NAME}`,
    "        transport: streamable-http",
    `        url: ${o.url}`,
  ];
  return `${lines.join("\n")}\n`;
}
