import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { World } from "./world.ts";

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.dispose();
  worlds = [];
});

const main = join(import.meta.dir, "../src/main.ts");

test("aoa mcp speaks MCP over stdio, and stdout carries nothing but protocol frames", async () => {
  const w = new World({ local: true });
  worlds.push(w);
  await w.start();

  const child = Bun.spawn(["bun", main, "mcp", "--config", w.configPath], {
    cwd: w.root,
    env: { PATH: process.env.PATH, HOME: w.root },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const raw: string[] = [];
    async function nextLine(): Promise<string> {
      for (;;) {
        const at = buffered.indexOf("\n");
        if (at >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          raw.push(line);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`stdout ended; stderr: ${await new Response(child.stderr).text()}`);
        buffered += decoder.decode(value, { stream: true });
      }
    }
    const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
    });
    expect(JSON.parse(await nextLine())).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "aoa" } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = JSON.parse(await nextLine());
    expect(listed).toMatchObject({ jsonrpc: "2.0", id: 2 });
    expect(listed.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["answer", "close", "messages", "send", "status"]);

    // Closing stdin ends the server; whatever else it wrote to stdout must still be protocol frames.
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    raw.push(...buffered.split("\n").filter((l) => l !== ""));
    for (const line of raw) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  } finally {
    child.kill();
  }
}, 20_000);

test("aoa mcp answers a 2026-07-28 client over stdio", async () => {
  const w = new World({ local: true });
  worlds.push(w);
  await w.start();
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [main, "mcp", "--config", w.configPath],
        cwd: w.root,
        env: { PATH: process.env.PATH ?? "", HOME: w.root },
        stderr: "ignore",
      }),
    );
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["answer", "close", "messages", "send", "status"]);
  } finally {
    await client.close();
  }
}, 20_000);
