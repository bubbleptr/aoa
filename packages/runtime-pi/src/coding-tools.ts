import type { ToolDef } from "@aoa/kernel";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

/** The part of pi's built-in tool objects this adapter uses. */
type PiTool = {
  name: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  // `any`: each built-in types its own params, and pi has already validated them against `parameters`.
  execute(toolCallId: string, params: any): Promise<unknown>;
};

const BUILTINS: Array<{ create: (cwd: string) => PiTool; idempotent: boolean }> = [
  { create: createBashTool, idempotent: false },
  { create: createReadTool, idempotent: true },
  { create: createEditTool, idempotent: false },
  { create: createWriteTool, idempotent: false },
  { create: createGrepTool, idempotent: true },
  { create: createFindTool, idempotent: true },
  { create: createLsTool, idempotent: true },
];

/**
 * pi's built-in coding tools as kernel tools, so they run through the kernel's journal like any other.
 * Each call builds the pi tool for the session's workdir; `execute` returns pi's own `{ content, details }`.
 */
export function codingTools(): ToolDef[] {
  return BUILTINS.map(({ create, idempotent }) => {
    // Name, description and schema do not depend on the directory, so any path serves as the template.
    const template = create(".");
    return {
      name: template.name,
      description: template.description,
      schema: template.parameters,
      idempotent,
      async execute(args, ctx) {
        if (ctx.workdir === null) {
          throw new Error(`${template.name} needs a working directory, and this session has none`);
        }
        const tool = create(ctx.workdir);
        const params = tool.prepareArguments ? tool.prepareArguments(args) : args;
        return tool.execute(ctx.callId, params);
      },
    };
  });
}
