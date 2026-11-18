#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createTui } from "./tui.ts";

function pickModel(): { provider: string; modelId: string; apiKey: string } {
  if (process.env.AOA_PROVIDER && process.env.AOA_MODEL && process.env.AOA_API_KEY) {
    return { provider: process.env.AOA_PROVIDER, modelId: process.env.AOA_MODEL, apiKey: process.env.AOA_API_KEY };
  }
  const presets = [
    ["deepseek", "deepseek-chat", process.env.DEEPSEEK_API_KEY],
    ["anthropic", "claude-sonnet-4-5", process.env.ANTHROPIC_API_KEY],
    ["openai", "gpt-4.1", process.env.OPENAI_API_KEY],
  ] as const;
  for (const [provider, modelId, apiKey] of presets) {
    if (apiKey) return { provider, modelId, apiKey };
  }
  console.error("Set DEEPSEEK_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY (or AOA_PROVIDER + AOA_MODEL + AOA_API_KEY).");
  process.exit(1);
}

const model = pickModel();
const dataDir = resolve(process.env.AOA_TUI_DIR ?? ".aoa-tui");
mkdirSync(dataDir, { recursive: true });

const store = sqliteStore(`${dataDir}/tui.db`);
const tui = createTui({
  store,
  ...model,
  cwd: process.cwd(),
  dataDir,
  write: (chunk) => process.stdout.write(chunk),
});

console.log(`aoa tui · ${model.provider}/${model.modelId} · /y approve · /n [reason] deny · /abort stop · /q quit`);
tui.host.start();

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();

rl.on("line", (line) => {
  if (tui.handleLine(line) === "quit") {
    rl.close();
    return;
  }
  rl.prompt();
});

rl.on("SIGINT", () => {
  if (tui.abortActive()) {
    process.stdout.write("\n  (interrupted; Ctrl-C again to quit)\n");
    rl.prompt();
    return;
  }
  rl.close();
});

await new Promise<void>((done) => rl.once("close", done));
await tui.host.stop();
tui.host.close();
