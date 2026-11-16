import { afterEach, describe, expect, test } from "bun:test";
import { World, call, say } from "./world.ts";

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.dispose();
  worlds = [];
});

async function world(): Promise<World> {
  const w = new World({ local: true });
  worlds.push(w);
  return w.start();
}

type Listing = {
  messages: { id: string; thread: string | null; kind: string; body: string; callId: string | null }[];
  cursor: string | null;
};

async function list(w: World, ...flags: string[]): Promise<Listing> {
  const r = await w.cli("messages", "--json", ...flags);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
}

/** Lets a command that waits on the fake clock notice that time has passed. */
async function tick(w: World, ms: number) {
  w.advance(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("aoa messages", () => {
  test("lists what the agent said, and --since returns only what came after the cursor", async () => {
    const w = await world();
    expect(await list(w)).toEqual({ messages: [], cursor: null });

    w.script([call("notify", { body: "First is done." }), say("Done.")]);
    const thread = (await w.cli("send", "Do the first thing.")).out.trim();
    await w.drain();

    const first = await list(w);
    expect(first.messages.map((m) => [m.thread, m.kind, m.body])).toEqual([[thread, "message", "First is done."]]);
    expect(first.cursor).toBe(first.messages[0]!.id);
    expect(await list(w, "--since", first.cursor!)).toEqual({ messages: [], cursor: first.cursor });

    w.script([call("notify", { body: "Second is done." }), say("Done.")]);
    await w.cli("send", "--to", thread, "Now the second thing.");
    await w.drain();

    const later = await list(w, "--since", first.cursor!);
    expect(later.messages.map((m) => m.body)).toEqual(["Second is done."]);
    expect((await list(w)).messages).toHaveLength(2);

    const text = await w.cli("messages", "--since", first.cursor!);
    expect(text.out).toContain("Second is done.");
    expect(text.out).not.toContain("First is done.");
    expect(text.out).toContain(`cursor: ${later.cursor}`);
  });

  test("an approval request carries its call id, and disappears once it is answered before delivery", async () => {
    const w = await world();
    w.judge = () => "unsure";
    w.script([call("bash", { command: "echo deployed >> deploy.log" }), say("Deployed.")]);
    await w.cli("send", "Deploy it.");
    await w.drain();

    const asked = await list(w);
    expect(asked.messages.map((m) => m.kind)).toEqual(["approval_request"]);
    const callId = asked.messages[0]!.callId!;
    const shown = await w.cli("messages");
    expect(shown.out).toContain(`aoa answer ${callId} approve`);

    expect((await w.cli("answer", callId, "deny", "not today")).code).toBe(0);
    expect((await list(w)).messages).toEqual([]);
  });

  test("an unknown cursor is an error, not an empty list", async () => {
    const w = await world();
    const r = await w.cli("messages", "--since", "no-such-message");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no-such-message");
  });

  test("--wait returns as soon as a message arrives", async () => {
    const w = await world();
    w.script([call("notify", { body: "Finished while you waited." }), say("Done.")]);
    await w.cli("send", "Do it.");

    let done = false;
    const waiting = list(w, "--wait", "60").then((l) => {
      done = true;
      return l;
    });
    await tick(w, 3000);
    expect(done).toBe(false);

    await w.drain();
    await tick(w, 1000);
    expect((await waiting).messages.map((m) => m.body)).toEqual(["Finished while you waited."]);
  });

  test("--wait gives up after its time with an empty list", async () => {
    const w = await world();
    let done = false;
    const waiting = list(w, "--wait", "5").then((l) => {
      done = true;
      return l;
    });
    const started = w.clock.now();
    // Each round: the command is asleep on the clock, or has returned.
    while (!done) {
      await Promise.race([waiting, w.clock.timerPending()]);
      if (!done) w.advance(1000);
    }
    expect(w.clock.now() - started).toBe(5000);
    expect(await waiting).toEqual({ messages: [], cursor: null });
  });
});
