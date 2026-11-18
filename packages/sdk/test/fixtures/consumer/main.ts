// A program in another repository: it knows the published packages and nothing else of aoa.
import { createHost, systemClock, type KernelRuntime } from "@aoa/sdk";
import { renderAnswer } from "@aoa/sdk/prompt";
import { sqliteStore } from "@aoa/store-sqlite";

const runtime: KernelRuntime = {
  kind: "kernel",
  async run(input) {
    const notify = input.tools.find((t) => t.name === "notify")!;
    await notify.invoke("c1", { body: `got ${input.events.length} event(s)` });
    return { end: { kind: "silent" } };
  },
};

const host = createHost({ store: sqliteStore(":memory:"), clock: systemClock, log: () => {} });
const agent = host.agent({ name: "hello", inbox: "hello", runtime, debounceMs: 0 });
agent.append({ source: "user_message", dedupeKey: "m1", payload: { text: "hi" }, thread: "t", trusted: true });
await agent.step.worker();
console.log(JSON.stringify(host.messages().map((m) => [m.status, m.body])));
// What a tier-2 adapter uses, without pi installed.
if (typeof renderAnswer !== "function") throw new Error("no prompt rendering");
host.close();
