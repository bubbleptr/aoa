// A program in another repository: it installs only `@aoa-dev/sdk` and nothing else of aoa.
import { createHost, sqliteStore, systemClock } from "@aoa-dev/sdk";
import { loopRuntime } from "@aoa-dev/sdk/loop";
import { renderAnswer } from "@aoa-dev/sdk/prompt";

const runtime = loopRuntime({
  systemPrompt: "Say how many events arrived.",
  async complete({ messages }) {
    const events = messages.filter((m) => m.role === "user").length;
    return { text: `got ${events} event(s)` };
  },
});

const host = createHost({ store: sqliteStore(":memory:"), clock: systemClock, log: () => {} });
const agent = host.agent({ name: "hello", inbox: "hello", runtime, reply: "final_text", debounceMs: 0 });
agent.append({ source: "user_message", dedupeKey: "m1", payload: { text: "hi" }, thread: "t", trusted: true });
await agent.step.worker();
console.log(JSON.stringify(host.messages().map((m) => [m.status, m.body])));
// What a tier-2 adapter uses, without pi installed.
if (typeof renderAnswer !== "function") throw new Error("no prompt rendering");
host.close();
