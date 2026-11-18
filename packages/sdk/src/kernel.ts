import {
  askUserTools,
  followTools,
  memoryTools,
  outboxTools,
  systemClock,
  timerTools,
  type Risk,
  type ToolDef,
} from "./kernel/index.ts";
import { sendToTool } from "./send-to.ts";

/**
 * What an application needs of the kernel, so it depends on the SDK alone: every type, and the few values that are
 * not part of a host (the system clock, the file memory, the `follow` tool, the policy's decision on its own, and two
 * constants an application's own pages and channels use).
 */
export type * from "./kernel/index.ts";
export { DEAD_NOTICE_PREFIX, RESIDENT_RECENT_MESSAGES, decide, dirMemory, followTools, systemClock } from "./kernel/index.ts";

/**
 * The tier each tool the SDK can give an agent declares: the built-in ones, `follow` and `send_to`. For deciding a
 * call known only by its tool name (a replay, a test); a live call takes its tier from its tool.
 */
export function builtinToolRisk(): Record<string, Risk> {
  // Built only to read names and tiers: nothing they would run against is needed.
  const inert = undefined as never;
  const deps = { store: inert, clock: systemClock, inboxId: "" };
  const defs: ToolDef[] = [
    ...timerTools(deps),
    ...outboxTools(deps),
    ...memoryTools(inert),
    ...askUserTools(),
    ...followTools(deps),
    sendToTool({ agents: [] }),
  ];
  return Object.fromEntries(defs.flatMap((d) => (d.risk ? [[d.name, d.risk]] : [])));
}
