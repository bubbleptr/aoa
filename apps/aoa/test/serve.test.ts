import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { serve } from "../src/serve.ts";
import { USER, World, call, say } from "./world.ts";

let w: World;
afterEach(() => w.dispose());

/** Yields to the event loop until `ok()` holds; real git and SQLite work in between, so no fixed delay fits. */
async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("serve polls, runs, delivers, picks up another process's send on its nudge, and stops cleanly", async () => {
  w = await new World().start();
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const issue = w.gh.addIssue({ author: USER, title: "Say hi", body: "", labels: ["aoa"] });
  w.script([call("notify", { body: "Hi!" }), say("Done."), say("Seen.")]);

  const serving = serve(w.agent, stopped);
  await until(() => w.events().length === 1, "the first poll");
  w.advance(2000);
  await until(() => w.gh.commentsOn(issue).length === 1, "the run's message to be delivered");
  expect(w.runs().map((r) => r.end?.kind)).toEqual(["sent"]);

  // `aoa send` writes from another process and wakes nobody; the 5-second nudge finds it.
  expect((await w.cli("send", "Another task")).code).toBe(0);
  w.advance(5000);
  await until(() => w.runs().length === 2 && w.runs()[1]!.end !== null, "the sent task's run");

  stop();
  await serving;
  expect(w.logs.at(-1)).toBe("stopped");
  expect(w.logs.filter((l) => / started in session /.test(l))).toHaveLength(2);
  expect(w.logs.some((l) => l.startsWith("delivered message"))).toBe(true);
});

test("in local mode serve runs a sent task, writes its message, and closes it on the nudge after aoa close", async () => {
  w = await new World({ local: true }).start();
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  w.script([call("notify", { body: "Hi!" }), say("Done.")]);

  const serving = serve(w.agent, stopped);
  const thread = (await w.cli("send", "Say hi")).out.trim();
  w.advance(5000);
  await until(() => w.notes.length === 1, "the run's message to be delivered");
  const session = w.sessions()[0]!;

  expect((await w.cli("close", thread, "discarded")).code).toBe(0);
  w.advance(5000);
  await until(() => w.sessions()[0]!.status === "closed" && !existsSync(session.workdir!), "the session to be closed");

  stop();
  await serving;
  expect(w.logs.at(-1)).toBe("stopped");
});
