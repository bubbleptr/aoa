import type { ToolDef } from "@aoa/kernel";

export type CountingTool = ToolDef & { effects: unknown[] };

/** A tool with an external effect the test can count. */
export function countingTool(name: string, idempotent = false): CountingTool {
  const effects: unknown[] = [];
  return {
    name,
    description: `Test tool ${name}`,
    schema: { type: "object" },
    idempotent,
    effects,
    async execute(args) {
      effects.push(args);
      return { done: effects.length };
    },
  };
}
