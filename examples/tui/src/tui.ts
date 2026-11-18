import {
  createHost,
  dirMemory,
  type Agent,
  type Clock,
  type Host,
  type HostStore,
  type OutMsg,
  type ToolDef,
} from "@aoa-dev/sdk";
import { piRuntime } from "@aoa-dev/sdk/pi";
import { codingRules, codingTools } from "@aoa-dev/sdk/tools/coding";
import type { Provider } from "@earendil-works/pi-ai";

export const TUI_THREAD = "tui";

export const TUI_PROMPT =
  "You are a concise terminal assistant running on aoa. Reply directly in plain text. " +
  "Read-only checks run right away; file edits and non-trivial shell commands pause for the user's approval.";

export type TuiOptions = {
  store: HostStore;
  provider: string;
  modelId: string;
  apiKey?: string;
  providers?: Provider[];
  cwd: string;
  dataDir: string;
  clock?: Clock;
  tools?: ToolDef[];
  write: (chunk: string) => void;
};

export type TuiApp = {
  readonly host: Host;
  readonly agent: Agent;
  /** Handles one line typed at the terminal prompt; returns `"quit"` on `/q`. */
  handleLine(raw: string): "quit" | "handled";
  /** Aborts the active run if one is in flight; returns whether a run was interrupted. */
  abortActive(): boolean;
};

export function createTui(o: TuiOptions): TuiApp {
  let streamedInRun = false;
  let inReasoning = false;
  const endReasoning = () => {
    if (!inReasoning) return;
    inReasoning = false;
    o.write("\x1b[0m\n");
  };

  const host = createHost({ store: o.store, ...(o.clock ? { clock: o.clock } : {}), log: () => {} });
  const agent = host.agent({
    name: "tui",
    inbox: "tui",
    runtime: piRuntime({
      provider: o.provider,
      modelId: o.modelId,
      ...(o.apiKey === undefined ? {} : { apiKey: o.apiKey }),
      ...(o.providers === undefined ? {} : { providers: o.providers }),
      agentDir: `${o.dataDir}/pi`,
      sessionsDir: `${o.dataDir}/sessions`,
      cwd: o.cwd,
      systemPrompt: TUI_PROMPT,
    }),
    tools: (builtins) => [
      ...(o.tools ?? codingTools()),
      ...builtins.filter((t) => t.name !== "notify"),
    ],
    memory: dirMemory(`${o.dataDir}/memory`),
    // Unlike an isolated worktree, a TUI works in the user's live directory, so file edits ask before writing.
    policy: { rules: codingRules, risk: { edit: "high", write: "high" } },
    reply: "final_text",
    approvals: { by: "answer" },
    debounceMs: 0,
    session: { prepare: async () => ({ workdir: o.cwd }) },
    channel: {
      async deliver(m: OutMsg) {
        endReasoning();
        if (m.detail?.kind === "approval") {
          const summary =
            m.detail.requestKind === "question"
              ? String((m.detail.args as { question?: unknown }).question ?? "")
              : `${m.detail.tool} ${compact(m.detail.args)}`;
          o.write(`\n  ? [${m.detail.requestKind}] ${summary}\n    type /y to approve, or /n [reason] to deny\n`);
          return;
        }
        if (m.detail?.kind === "dead_letter") {
          o.write(`\n  ! run stopped after repeated errors: ${m.detail.error ?? "unknown"}\n`);
          return;
        }
        if (streamedInRun) {
          streamedInRun = false;
          o.write("\n");
          return;
        }
        o.write(`\n${m.body}\n`);
      },
    },
    onRunEnd: () => {
      endReasoning();
    },
  });

  agent.activity((a) => {
    if (a.kind === "reasoning") {
      if (!inReasoning) {
        inReasoning = true;
        o.write("\x1b[2m");
      }
      o.write(a.delta);
      return;
    }
    endReasoning();
    if (a.kind === "text") {
      streamedInRun = true;
      o.write(a.delta);
    } else if (a.kind === "tool_start") {
      o.write(`\n  → ${a.tool} ${compact(a.args)}\n`);
    }
  });

  const abortActive = (): boolean => {
    const sessionId = agent.read.sessionFor(TUI_THREAD);
    return sessionId !== null && agent.abort(sessionId);
  };

  function handleLine(raw: string): "quit" | "handled" {
    const line = raw.trim();
    if (line === "") return "handled";
    if (line === "/q" || line === "/quit") return "quit";
    if (line === "/abort") {
      o.write(abortActive() ? "  (interrupted active run)\n" : "  (no run in flight)\n");
      return "handled";
    }
    const decision = /^\/(y|yes|n|no)\b\s*([\s\S]*)$/i.exec(line);
    if (decision) {
      const pending = agent.read.pending()[0];
      if (!pending) {
        o.write("  (nothing waiting for approval)\n");
        return "handled";
      }
      const approve = decision[1]!.toLowerCase().startsWith("y");
      const note = decision[2]!.trim();
      agent.answer(pending.callId, {
        verdict: approve ? "approve" : "deny",
        ...(note === "" ? {} : { text: note }),
        via: "tui",
      });
      return "handled";
    }
    agent.append({
      source: "user_message",
      dedupeKey: `tui:${crypto.randomUUID()}`,
      payload: { text: line },
      thread: TUI_THREAD,
      trusted: true,
    });
    return "handled";
  }

  return { host, agent, handleLine, abortActive };
}

function compact(args: unknown): string {
  const s = JSON.stringify(args);
  return s.length <= 80 ? s : `${s.slice(0, 79)}…`;
}
