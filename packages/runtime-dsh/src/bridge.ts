import { isDeepStrictEqual } from "node:util";
import type { SessionId, Tool, ToolResult } from "@aoa/kernel";
import { resultText } from "@aoa/runtime-pi/results";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_PREFIX } from "./patch.ts";

/** One `tool/call` or `tool/ptc-dispatch-start` the session logged, waiting for the call it belongs to. */
export type CallEntry = { sessionId: string; tool: string; args: unknown; claimed: boolean };

/** The session's calls, keyed by `(dsh session, callId or subCallId)`; written as the events arrive, read when dsh asks. */
export class CallTable {
  private readonly entries = new Map<string, { callId: string; entry: CallEntry }>();

  add(sessionId: string, callId: string, tool: string, args: unknown): void {
    const entry: CallEntry = { sessionId, tool, args, claimed: false };
    this.entries.set(`${sessionId}\u0000${callId}`, { callId, entry });
  }

  /** The call an approval request names, or null when aoa never saw it. */
  get(sessionId: string, callId: string): CallEntry | null {
    return this.entries.get(`${sessionId}\u0000${callId}`)?.entry ?? null;
  }

  /**
   * The call an MCP tool call belongs to: same session, the same dsh tool name, deeply equal arguments, not
   * claimed yet, the earliest. Concurrent identical calls are the same operation, so taking them in order is
   * deterministic. Null when nothing matches, and the bridge then refuses the call.
   */
  claim(sessionId: string, tool: string, args: unknown): { callId: string; entry: CallEntry } | null {
    for (const { callId, entry } of this.entries.values()) {
      if (entry.claimed || entry.sessionId !== sessionId) continue;
      if (entry.tool !== tool || !isDeepStrictEqual(entry.args, args)) continue;
      entry.claimed = true;
      return { callId, entry };
    }
    return null;
  }
}

export type Bridge = {
  /** `http://127.0.0.1:<port>/mcp/<token>`: loopback, and a path nothing else this process runs can guess. */
  url: string;
  /** Whether no tool call is running and no answer is still owed to dsh. */
  idle(): boolean;
  close(): void;
};

export type BridgeOptions = {
  /** The aoa session: kernel call ids are `<session>:<dsh call id>`. */
  sessionId: SessionId;
  /** The dsh session the call table and its tool calls belong to. */
  dshSessionId: string;
  tools: Tool[];
  table: CallTable;
  /** Called once the answer to one MCP request has been written; `idle()` says whether a tool still runs. */
  replied(): void;
  /** A tool call ended deferred: the run stops on this kernel call id. */
  deferred(callId: string): void;
  /** Set once the run is stopping: later calls are refused without asking the kernel. */
  stopping(): boolean;
  log(line: string): void;
};

const WAITS_FOR_USER =
  "This call waits for the user's decision. It has not been executed; the answer arrives in a later message.";

const NO_SUCH_TOOL = "aoa offers no such tool. Use only the tools listed by this server.";

const STOPPING = "This run is stopping now; the call was not executed. Ask again in the next turn.";

/**
 * Serves aoa's tools to dsh over MCP on loopback, for one run. dsh's MCP client sends only a name and
 * arguments, so the bridge recognizes the call by the `tool/call` event the session logged before it: a call
 * it cannot place is an MCP error and is not executed.
 */
export async function startBridge(o: BridgeOptions): Promise<Bridge> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const path = `/mcp/${token}`;
  /** Tool calls running now: the run does not end, and dsh is not stopped, while one is in flight. */
  let running = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handle(req),
  });

  async function handle(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== path) return new Response("not found", { status: 404 });
    if (req.method !== "POST") {
      const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null });
      return new Response(body, { status: 405, headers: { "content-type": "application/json" } });
    }
    // One server and transport per request: the bridge holds no per-connection state, so any request may
    // arrive on any connection, in any order.
    const mcp = new Server({ name: "aoa", version: "0.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: o.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema as { type: "object" } })),
    }));
    let invoked = false;
    mcp.setRequestHandler(CallToolRequestSchema, (request) => call(request.params.name, request.params.arguments, () => (invoked = true)));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // The answer is out. Only now does the call stop counting as running, and only then may the run end:
      // a deferred call stops dsh after dsh has read the answer, and a slow call is never cut off by it.
      if (invoked) running--;
      o.replied();
    }
  }

  async function call(
    name: string,
    args: unknown,
    started: () => void,
  ): Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> {
    const text = (body: string, isError: boolean) => ({ content: [{ type: "text" as const, text: body }], isError });
    if (o.stopping()) return text(STOPPING, true);
    const tool = o.tools.find((t) => t.name === name);
    if (!tool) return text(NO_SUCH_TOOL, true);
    const claimed = o.table.claim(o.dshSessionId, `${MCP_TOOL_PREFIX}${name}`, args);
    if (!claimed) {
      o.log(`dsh called the aoa tool ${name} with no matching tool/call in session ${o.dshSessionId}; refused`);
      return text("aoa cannot identify this call: no matching tool call was logged for it. It was not executed.", true);
    }
    started();
    running++;
    const callId = `${o.sessionId}:${claimed.callId}`;
    let result: ToolResult;
    try {
      result = await tool.invoke(callId, claimed.entry.args);
    } catch (err) {
      o.log(`the aoa tool ${name} threw: ${err instanceof Error ? err.message : String(err)}`);
      return text("The call failed.", true);
    }
    switch (result.status) {
      case "ok":
        return text(resultText(result.output), false);
      case "error":
        return text(result.error, true);
      case "unknown":
        return text(result.message, false);
      case "deferred":
        o.deferred(callId);
        return text(WAITS_FOR_USER, false);
    }
  }

  return {
    url: `http://127.0.0.1:${server.port}${path}`,
    idle: () => running === 0,
    close: () => void server.stop(true),
  };
}
