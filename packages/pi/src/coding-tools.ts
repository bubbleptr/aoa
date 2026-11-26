import type { Risk, ToolDef } from "@aoa-dev/sdk";
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
  // `any`: each built-in types its own params, and pi has already validated them against `parameters`.
  execute(toolCallId: string, params: any, signal?: AbortSignal): Promise<unknown>;
};

/** Reading and editing files is low risk: the policy's rules keep it inside the working directory. A command is medium. */
const BUILTINS: Array<{ create: (cwd: string) => PiTool; idempotent: boolean; risk: Risk }> = [
  { create: createBashTool, idempotent: false, risk: "medium" },
  { create: createReadTool, idempotent: true, risk: "low" },
  { create: createEditTool, idempotent: false, risk: "low" },
  { create: createWriteTool, idempotent: false, risk: "low" },
  { create: createGrepTool, idempotent: true, risk: "low" },
  { create: createFindTool, idempotent: true, risk: "low" },
  { create: createLsTool, idempotent: true, risk: "low" },
];

/**
 * pi's built-in coding tools as kernel tools, so they run through the kernel's journal like any other.
 * Each call builds the pi tool for the session's workdir; `execute` returns pi's own `{ content, details }`.
 */
export function codingTools(): ToolDef[] {
  return BUILTINS.map(({ create, idempotent, risk }) => {
    // Name, description and schema do not depend on the directory, so any path serves as the template.
    const template = create(".");
    return {
      name: template.name,
      description: template.description,
      schema: template.parameters,
      idempotent,
      risk,
      async execute(args, ctx) {
        if (ctx.workdir === null) {
          throw new Error(`${template.name} needs a working directory, and this session has none`);
        }
        return create(ctx.workdir).execute(ctx.callId, args, ctx.signal);
      },
    };
  });
}
