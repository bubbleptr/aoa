/**
 * Runs the digest against a real repository and model:
 *   AOA_DIGEST_REPO=owner/repo ANTHROPIC_API_KEY=... bun examples/digest/src/main.ts
 * GITHUB_TOKEN is optional (public repositories). Messages are printed as they are written.
 */
import { createHost } from "@aoa/sdk";
import { piRuntime } from "@aoa/sdk/pi";
import { sqliteStore } from "@aoa/store-sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { digestAgent, githubIssues } from "./index.ts";

const [owner, repo] = (process.env.AOA_DIGEST_REPO ?? "").split("/");
if (!owner || !repo) throw new Error("Set AOA_DIGEST_REPO to owner/repo.");
const dir = join(homedir(), ".aoa-digest");
mkdirSync(dir, { recursive: true });

const host = createHost({ store: sqliteStore(join(dir, "digest.db")) });
digestAgent(host, {
  inbox: `digest/${owner}/${repo}`,
  runtime: piRuntime({
    provider: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: process.env.ANTHROPIC_API_KEY,
    agentDir: join(dir, "pi"),
    sessionsDir: join(dir, "sessions"),
    cwd: dir,
    systemPrompt: "You check a repository's issues for its maintainer and speak up only when something needs them.",
  }),
  issues: githubIssues({ owner, repo, ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) }),
  // 08:00 UTC every day; a constant, so a restart does not move it.
  anchor: Date.UTC(2026, 0, 1, 8),
});
let seen: string | undefined;
host.watch(() => {
  const fresh = host.messages(seen === undefined ? {} : { since: seen });
  for (const m of fresh) console.log(`${new Date(m.createdAt).toISOString()}\n${m.body}\n`);
  seen = fresh.at(-1)?.id ?? seen;
});
host.start();
process.on("SIGINT", () => void host.stop().then(() => host.close()));
