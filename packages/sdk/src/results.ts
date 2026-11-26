/**
 * The result shape pi's own tools return; `codingTools()` outputs carry it through the kernel journal. Written out
 * rather than imported from pi, so `@aoa-dev/sdk/prompt` needs no pi installed.
 */
export type PiToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details?: unknown;
  isError?: boolean;
};

/** Checked structurally because a replayed result comes back from the journal as parsed JSON. */
export function isPiToolResult(value: unknown): value is PiToolResult {
  if (typeof value !== "object" || value === null) return false;
  const content = (value as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.every((c) => typeof c === "object" && c !== null && (c.type === "text" || c.type === "image"))
  );
}

/** A tool output as text for the model: a string as is, pi's text blocks joined, anything else as JSON. */
export function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (isPiToolResult(output)) {
    return output.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType} image]`)).join("\n");
  }
  return JSON.stringify(output) ?? "";
}
