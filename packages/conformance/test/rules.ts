import type { Rule } from "@aoa-dev/kernel";

const command = (args: unknown): string =>
  typeof args === "object" && args !== null && typeof (args as { command?: unknown }).command === "string" ? (args as { command: string }).command : "";

/**
 * Stand-ins for the rules an application brings (the kernel carries none). They only give the kernel a rule to obey;
 * the real coding rules are tested in `@aoa-dev/sdk`.
 */
export const testRules: Rule[] = [
  { name: "no-sudo", match: (c) => (c.tool === "bash" && /^sudo\b/.test(command(c.args)) ? "block" : null) },
  { name: "no-force-push", match: (c) => (c.tool === "bash" && /\bgit push\b.*--force/.test(command(c.args)) ? "block" : null) },
  { name: "network-when-tainted", match: (c, ctx) => (c.tool === "bash" && ctx.tainted && /\bcurl\b/.test(command(c.args)) ? "defer" : null) },
];
