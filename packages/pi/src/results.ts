import { isPiToolResult, resultText, type PiToolResult } from "@aoa-dev/sdk/prompt";

/** An `ok` output as the result pi hands to the model. */
export function okToPi(output: unknown): PiToolResult {
  if (isPiToolResult(output)) return { content: output.content, details: output.details, isError: output.isError };
  return text(resultText(output));
}

export function text(t: string): PiToolResult {
  return { content: [{ type: "text", text: t }] };
}
