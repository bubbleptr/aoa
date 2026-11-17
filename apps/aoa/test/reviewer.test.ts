import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildExport, reviewInputOf } from "../eval/export.ts";
import { REVIEW_CONTEXT, REVIEWER_PROMPT, reviewMessage } from "../src/reviewer.ts";
import { World, call, say } from "./world.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

async function world(): Promise<World> {
  const w = new World({ local: true });
  cleanup.push(() => w.dispose());
  return w.start();
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : (content as { text?: string }[]).map((c) => c.text ?? "").join("");

/** What the reviewer was sent, one user message per reviewed call. The test model gets the system prompt as message 0. */
const reviewed = (w: World): string[] =>
  w.modelRequests
    .filter((r) => (r.systemPrompt ?? textOf(r.messages[0]!.content)) === REVIEWER_PROMPT)
    .map((r) => textOf(r.messages.at(-1)!.content));

const task = [
  call("bash", { command: "printf '%s-%s' alpha omega | tee marker.txt" }),
  call("bash", { command: "echo second | tee -a marker.txt" }),
  say("Done."),
];

test("the reviewer sees the user's task and the task's earlier calls, never what a call returned", async () => {
  const w = await world();
  w.script(task);
  await w.cli("send", "Print the marker, then echo.");
  await w.drain();

  const second = reviewed(w).find((m) => m.includes("echo second"))!;
  expect(second).toContain("<user_request>");
  expect(second).toContain("Print the marker, then echo.");
  expect(second).toContain("<prior_calls>");
  expect(second).toContain("printf");
  // The first call printed alpha-omega; results are where injected text would arrive, so they never reach the reviewer.
  expect(second).not.toContain("alpha-omega");
});

test("ask leaves the call to the user", async () => {
  const w = await world();
  w.judge = (shown) => (shown.includes("echo second") ? "ask" : "allow");
  w.script(task);
  await w.cli("send", "Print the marker, then echo.");
  await w.drain();

  const [session] = w.sessions();
  expect(session).toMatchObject({ status: "paused" });
  const { pending } = JSON.parse((await w.cli("status", "--json")).out);
  expect(pending).toHaveLength(1);
  expect(pending[0].callId).toBe(session!.pending);
});

test("the reviewer is sent exactly what the eval replayed for the same calls", async () => {
  const w = await world();
  w.script(task);
  await w.cli("send", "Print the marker, then echo.");
  await w.drain();

  const [session] = w.sessions();
  const db = new Database(w.agent.paths.db, { readonly: true });
  cleanup.push(() => db.close());
  const { calls } = buildExport(db, {
    agentOf: () => ({ name: "default", role: "implement", mode: "local" }),
    workdirOf: () => session!.workdir!,
  });
  const replayed = calls.filter((c) => c.tool === "bash").map((c) => reviewMessage(reviewInputOf(c), REVIEW_CONTEXT));
  expect(replayed).toHaveLength(2);
  expect(reviewed(w).sort()).toEqual(replayed.sort());
});
