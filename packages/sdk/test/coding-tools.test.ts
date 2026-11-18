import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDef, ToolExecContext } from "../src/kernel/index.ts";
import { codingTools } from "../src/tools/coding/index.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function workdir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aoa-coding-tools-")));
  dirs.push(dir);
  return dir;
}

function tool(name: string): ToolDef {
  const def = codingTools().find((t) => t.name === name);
  if (!def) throw new Error(`codingTools() has no ${name}`);
  return def;
}

const ctx = (dir: string | null): ToolExecContext => ({ sessionId: "s", callId: "c", workdir: dir, signal: new AbortController().signal });

const textOf = (out: unknown) =>
  (out as { content: Array<{ type: string; text?: string }> }).content.map((c) => c.text ?? "").join("");

describe("codingTools", () => {
  test("read resolves relative paths inside the session's workdir", async () => {
    const a = workdir();
    const b = workdir();
    writeFileSync(join(a, "notes.txt"), "from a\n");
    writeFileSync(join(b, "notes.txt"), "from b\n");

    expect(textOf(await tool("read").execute({ path: "notes.txt" }, ctx(a)))).toContain("from a");
    expect(textOf(await tool("read").execute({ path: "notes.txt" }, ctx(b)))).toContain("from b");
  });

  test("bash runs in the session's workdir", async () => {
    const dir = workdir();

    const out = await tool("bash").execute({ command: "pwd" }, ctx(dir));

    expect(realpathSync(textOf(out).trim())).toBe(dir);
  });

  test("bash stops its command when the run's signal fires", async () => {
    const controller = new AbortController();
    const running = tool("bash").execute({ command: "sleep 30" }, { ...ctx(workdir()), signal: controller.signal });
    controller.abort(new Error("the host stopped"));

    await expect(running).rejects.toThrow();
  });

  test("a tool fails clearly when the session has no workdir", async () => {
    await expect(tool("bash").execute({ command: "pwd" }, ctx(null))).rejects.toThrow(/working directory/);
  });
});
