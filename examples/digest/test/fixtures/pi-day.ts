/**
 * One daily check through pi with a scripted model, driven only by `step`. Run as a child process by
 * no-git.test.ts with no git on PATH and a working directory outside any repository. Prints a JSON report.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { FakeClock } from "@aoa/conformance";
import { createHost } from "@aoa/sdk";
import { piRuntime } from "@aoa/sdk/pi";
import { sqliteStore } from "@aoa/store-sqlite";
import { DIGEST_JOB, digestAgent } from "../../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "aoa-digest-pi-"));
const faux = fauxProvider({ provider: "scripted", models: [{ id: "scripted-model" }] });
const requests: Message[][] = [];
const step = (m: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: Message[] }) => {
  requests.push([...context.messages]);
  return m;
};
faux.setResponses([
  step(fauxAssistantMessage(fauxToolCall("recent_issues", {}, { id: "c1" }), { stopReason: "toolUse" })),
  step(fauxAssistantMessage(fauxToolCall("notify", { body: "#7 needs you" }, { id: "c2" }), { stopReason: "toolUse" })),
  step(fauxAssistantMessage("Done.")),
]);

const clock = new FakeClock(Date.UTC(2026, 10, 18, 7));
const host = createHost({ store: sqliteStore(join(root, "digest.db")), clock, log: () => {} });
const agent = digestAgent(host, {
  inbox: "digest",
  runtime: piRuntime({
    provider: "scripted",
    modelId: "scripted-model",
    apiKey: "test",
    agentDir: join(root, "agent"),
    sessionsDir: join(root, "sessions"),
    cwd: root,
    systemPrompt: "You check issues.",
    providers: [faux.provider],
  }),
  issues: { updatedSince: async () => [{ number: 7, title: "Crash on start", url: "u", state: "open", labels: [], updatedAt: 0, body: "" }] },
  anchor: Date.UTC(2026, 10, 18, 8),
});
clock.advance(60 * 60_000);
agent.step.scheduler();
await agent.step.worker();

const firstRequest = JSON.stringify(requests[0]);
console.log(
  JSON.stringify({
    jobInFirstRequest: firstRequest.includes(JSON.stringify(DIGEST_JOB).slice(1, 40)),
    runs: agent.read.runs().map((r) => ({ end: r.end?.kind ?? null, error: r.error })),
    messages: host.messages().map((m) => ({ body: m.body, status: m.status })),
  }),
);
host.close();
