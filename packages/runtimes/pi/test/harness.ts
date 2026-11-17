import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallId, Event, RunInput, Tool, ToolResult } from "@aoa/kernel";
import {
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { piRuntime } from "../src/index.ts";

export const API_KEY = "sk-test-secret-0123456789";

/** A pi runtime whose model is a scripted faux provider; nothing leaves the process. */
export function scriptedRuntime() {
  const root = mkdtempSync(join(tmpdir(), "aoa-runtime-pi-"));
  const faux = fauxProvider({ provider: "scripted", models: [{ id: "scripted-model" }] });
  /** Every request the model received, in order. */
  const requests: Message[][] = [];
  const runtime = piRuntime({
    provider: "scripted",
    modelId: "scripted-model",
    apiKey: API_KEY,
    agentDir: join(root, "agent"),
    sessionsDir: join(root, "sessions"),
    cwd: root,
    systemPrompt: "You are a test agent.",
    providers: [faux.provider],
  });
  const script = (steps: Array<AssistantMessage | ((messages: Message[]) => AssistantMessage)>) =>
    faux.setResponses(
      steps.map<FauxResponseStep>((step) => (context) => {
        requests.push([...context.messages]);
        return typeof step === "function" ? step(context.messages) : step;
      }),
    );
  return {
    root,
    runtime,
    requests,
    script,
    pending: () => faux.getPendingResponseCount(),
    /** The next model request never answers; `requested` settles once it was made. It ends only by abort. */
    hang() {
      let made = () => {};
      const requested = new Promise<void>((resolve) => (made = resolve));
      faux.setResponses([
        (_context, options) =>
          new Promise<AssistantMessage>((_resolve, reject) => {
            made();
            options?.signal?.addEventListener("abort", () => reject(new Error("request aborted")));
          }),
      ]);
      return requested;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const reply = (text: string) => fauxAssistantMessage(text);

export type Invocation = { callId: CallId; args: unknown };

/** A kernel tool that records each invoke and answers from `respond`. */
export function recordingTool(name: string, respond: (args: unknown) => ToolResult) {
  const calls: Invocation[] = [];
  const tool: Tool = {
    name,
    description: `Test tool ${name}.`,
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    async invoke(callId, args) {
      calls.push({ callId, args });
      return respond(args);
    },
  };
  return { tool, calls };
}

let eventSeq = 0;

export function event(payload: unknown, over: Partial<Event> = {}): Event {
  eventSeq++;
  return {
    id: `evt-${eventSeq}`,
    inboxId: "inbox",
    source: "user_message",
    dedupeKey: `dedupe-${eventSeq}`,
    receivedAt: 0,
    payload,
    thread: null,
    resume: null,
    trusted: true,
    status: "in_run",
    leaseUntil: null,
    attempts: 0,
    nextAttemptAt: 0,
    run: null,
    ...over,
  };
}

export function runInput(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: "run-1",
    session: { id: "session-1", resumed: false, ref: null, workdir: null },
    events: [event({ text: "hello" })],
    resident: "",
    tools: [],
    signal: new AbortController().signal,
    ...over,
  };
}

/** The plain text of a message's content. */
export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

export function lastUserText(messages: Message[]): string {
  const user = messages.filter((m) => m.role === "user").at(-1);
  if (!user) throw new Error("no user message in the request");
  return textOf(user);
}
