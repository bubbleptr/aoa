import type { LoopComplete, LoopToolCall, LoopTurn } from "@aoa-dev/sdk/loop";

export type OpenAICompatConfig = {
  baseUrl?: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
};

type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Minimal OpenAI-compatible Chat Completions adapter for `@aoa-dev/sdk/loop`: works with OpenAI, DeepSeek, OpenRouter,
 * vLLM or Ollama using standard `fetch` and zero SDK dependencies.
 */
export function openaiComplete(config: OpenAICompatConfig): LoopComplete {
  const endpoint = `${(config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  const callFetch = config.fetch ?? fetch;

  return async ({ systemPrompt, messages, tools, signal }) => {
    const wireMessages: WireMessage[] = [{ role: "system", content: systemPrompt }, ...messages.map(toWire)];
    const res = await callFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: wireMessages,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.schema },
              })),
            }
          : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`chat completions HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("chat completions returned no message");
    const toolCalls: LoopToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
    }));
    return {
      ...(typeof msg.content === "string" && msg.content !== "" ? { text: msg.content } : {}),
      ...(typeof msg.reasoning_content === "string" && msg.reasoning_content !== "" ? { reasoning: msg.reasoning_content } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  };
}

function toWire(turn: LoopTurn): WireMessage {
  switch (turn.role) {
    case "user":
      return { role: "user", content: turn.content };
    case "assistant":
      return {
        role: "assistant",
        content: turn.text ?? null,
        ...(turn.toolCalls && turn.toolCalls.length > 0
          ? {
              toolCalls: undefined,
              tool_calls: turn.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: turn.callId,
        content: turn.isError ? `Error: ${turn.content}` : turn.content,
      };
  }
}
