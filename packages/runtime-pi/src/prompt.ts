import type { Event, RunInput, ToolResult } from "@aoa/kernel";
import { resultText } from "./results.ts";

type Answer = NonNullable<RunInput["answer"]>;

/**
 * JSON with `<`, `>` and `&` written as \u escapes: still valid JSON that decodes to the same value,
 * but no content can spell a tag, so nothing inside a block can close it or open another.
 */
export function encode(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The run's one user message: resident text, then the answer to a deferred call, then one block per event. */
export function renderUserMessage(input: RunInput): string {
  const parts: string[] = [];
  if (input.resident !== "") parts.push(input.resident);
  if (input.answer) parts.push(renderAnswer(input.answer));
  for (const e of input.events) parts.push(renderEvent(e));
  return parts.join("\n\n");
}

function renderEvent(e: Event): string {
  return `<event source=${encode(e.source)} trusted=${e.trusted} thread=${encode(e.thread)}>\n${encode(e.payload)}\n</event>`;
}

function renderAnswer(a: Answer): string {
  const head = `<answer call=${encode(a.callId)} tool=${encode(a.tool)} verdict=${encode(a.verdict)}>`;
  const call = `your earlier call to ${encode(a.tool)} with arguments ${encode(a.args)}`;
  const body =
    a.verdict === "approve"
      ? [
          `The user approved ${call}. It has already been executed; do not call it again.`,
          `Result: ${encode(a.result ? answerResult(a.result) : null)}`,
        ]
      : [
          `The user denied ${call}. It was not executed; do not call it again unless the user asks for it.`,
          `The user said: ${encode(a.text ?? "")}`,
        ];
  return [head, ...body, "</answer>"].join("\n");
}

function answerResult(result: ToolResult): string {
  switch (result.status) {
    case "ok":
      return resultText(result.output);
    case "error":
      return `Error: ${result.error}`;
    case "unknown":
      return result.message;
    case "deferred":
      return "The call is still waiting for a decision.";
  }
}
