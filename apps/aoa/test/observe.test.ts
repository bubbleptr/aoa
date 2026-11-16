import { afterEach, describe, expect, test } from "bun:test";
import { addSchedule } from "@aoa/kernel";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_FILE_CAP, MEMORY_TOTAL_CAP, type Snapshot, flows, snapshot } from "../src/observe.ts";
import { serve } from "../src/serve.ts";
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

const observe = (w: World): Snapshot => snapshot(w.agent);

async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("snapshot", () => {
  test("a run that writes memory, notifies and defers a call shows in every primitive", async () => {
    const w = await world();
    w.judge = () => "unsure";
    w.script([
      call("memory_write", { path: "notes/user.md", content: "Prefers short messages." }),
      call("notify", { body: "Working on it." }),
      call("bash", { command: "echo deployed >> deploy.log" }),
    ]);
    const thread = (await w.cli("send", "Deploy it.")).out.trim();
    await w.drain();
    // The dispatcher sends one message per session per pass.
    await w.dispatch();
    await w.dispatch();

    const s = observe(w);
    const session = w.sessions()[0]!.id;
    expect(s.events.counts).toMatchObject({ done: 1, pending: 0, in_run: 0, retrying: 0 });
    expect(s.events.rows[0]).toMatchObject({ source: "user_message", thread, status: "done", attempts: 0 });

    expect(s.outbox.counts.sent).toBe(2);
    expect(s.outbox.rows.map((r) => [r.kind, r.status, r.approval])).toEqual([
      ["approval_request", "sent", "pending"],
      ["message", "sent", null],
    ]);

    const [waiting] = s.permissions.waiting;
    expect(waiting).toMatchObject({ tool: "bash", basis: "classifier:unsure", sessionId: session });
    expect(waiting!.args).toContain("echo deployed");
    expect(waiting!.answer).toBe(`aoa answer ${waiting!.callId} approve|deny`);
    expect(s.permissions.last24h).toEqual({ allow: 2, defer: 1, block: 0 });
    expect(s.permissions.allowsByBasis).toEqual([{ basis: "risk:low", count: 2 }]);

    expect(s.memory.files.map((f) => [f.path, f.writtenBy])).toContainEqual(["notes/user.md", session]);
    expect(s.memory.writesToday).toEqual([{ sessionId: session, count: 1 }]);
  });

  test("a memory file is credited to the session that wrote it last, across sessions", async () => {
    const w = await world();
    const write = (content: string) => [call("memory_write", { path: "notes/x.md", content }), say("Noted.")];
    w.script(write("from A"));
    const a = (await w.cli("send", "Task A.")).out.trim();
    await w.drain();
    w.script(write("from B"));
    await w.cli("send", "Task B.");
    await w.drain();
    w.script(write("from A again"));
    await w.cli("send", "--to", a, "Once more.");
    await w.drain();

    const [first] = w.sessions();
    const s = observe(w);
    expect(s.memory.files.find((f) => f.path === "notes/x.md")?.writtenBy).toBe(first!.id);
  });

  test("a timer carries the full text the agent will get, the session it resumes and the thread it wakes", async () => {
    const w = await world();
    const note = `Check CI on main.\n${"If it failed, read the log and report which test. ".repeat(6)}`;
    w.script([call("wake_me_at", { inMs: 3_600_000, note }), say("Will check.")]);
    const thread = (await w.cli("send", "Watch CI.")).out.trim();
    await w.drain();
    const session = w.sessions()[0]!.id;
    const weekly = { note: "Read aoa status.\nNote in memory what changed since last week." };
    const schedule = addSchedule(w.agent.store, w.clock, w.agent.inboxId, {
      everyMs: 7 * 24 * 3_600_000,
      anchor: w.clock.now() + 60_000,
      payload: weekly,
      sessionId: session,
    });
    const other = { report: ["ci", "deps"] };
    addSchedule(w.agent.store, w.clock, w.agent.inboxId, { everyMs: 60_000, anchor: w.clock.now(), payload: other });

    const rows = observe(w).timers.rows;
    expect(rows.find((r) => r.kind === "follow_up")).toMatchObject({ status: "armed", sessionId: session, thread, text: note });
    expect(rows.find((r) => r.id === schedule.id)).toMatchObject({ sessionId: session, thread, text: weekly.note, everyMs: 7 * 24 * 3_600_000 });
    expect(rows.find((r) => r.kind === "schedule" && r.id !== schedule.id)).toMatchObject({
      sessionId: null,
      thread: null,
      text: JSON.stringify(other, null, 2),
    });
  });

  test("a memory file carries its text: whole when small, a valid head past the cap, none when it is not UTF-8", async () => {
    const w = await world();
    const dir = w.agent.paths.memory;
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "index.md"), "# Index\n\n- notes/big.md\n");
    // Three bytes a character, so the per-file cap falls inside one.
    const big = "记忆".repeat(MEMORY_FILE_CAP / 4);
    writeFileSync(join(dir, "notes/big.md"), big);
    writeFileSync(join(dir, "blob.bin"), Uint8Array.of(0x61, 0xff, 0xfe, 0x62));

    const files = observe(w).memory.files;
    expect(files.find((f) => f.path === "index.md")).toMatchObject({ text: "# Index\n\n- notes/big.md\n", truncated: false, binary: false });
    const head = files.find((f) => f.path === "notes/big.md")!;
    expect(head.truncated).toBe(true);
    expect(big.startsWith(head.text!)).toBe(true);
    expect(Buffer.byteLength(head.text!)).toBeLessThanOrEqual(MEMORY_FILE_CAP);
    expect(Buffer.byteLength(head.text!)).toBeGreaterThan(MEMORY_FILE_CAP - 3);
    expect(files.find((f) => f.path === "blob.bin")).toMatchObject({ text: null, binary: true, size: 4 });
  });

  test("memory text past the total cap goes to the latest files; older ones keep only a head", async () => {
    const w = await world();
    const dir = w.agent.paths.memory;
    mkdirSync(dir, { recursive: true });
    const count = Math.ceil(MEMORY_TOTAL_CAP / MEMORY_FILE_CAP) + 2;
    for (let i = 0; i < count; i++) {
      const path = join(dir, `f${i}.md`);
      writeFileSync(path, "x".repeat(MEMORY_FILE_CAP));
      utimesSync(path, 1_000 + i, 1_000 + i);
    }

    const files = observe(w).memory.files;
    expect(files.reduce((n, f) => n + f.text!.length, 0)).toBe(MEMORY_TOTAL_CAP);
    expect(files[0]).toMatchObject({ path: `f${count - 1}.md`, truncated: false });
    expect(files.at(-1)).toMatchObject({ path: "f0.md", text: "", truncated: true });
  });

  test("a failed run's event is retrying until its next try, then pending", async () => {
    const w = await world();
    w.script([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" })]);
    await w.cli("send", "Do it.");
    await w.drain();

    const s = observe(w);
    const [event] = w.events();
    expect(s.events.counts).toMatchObject({ retrying: 1, pending: 0 });
    expect(s.events.rows[0]).toMatchObject({ status: "retrying", attempts: 1, nextAttemptAt: event!.nextAttemptAt });
    expect(event!.nextAttemptAt).toBeGreaterThan(w.clock.now());
    expect(s.nextChangeAt).toBe(event!.nextAttemptAt);

    w.advance(event!.nextAttemptAt - w.clock.now());
    expect(observe(w).events.counts).toMatchObject({ retrying: 0, pending: 1 });
  });
});

describe("flows", () => {
  test("each step moves exactly its own edge, and an unchanged store moves none", async () => {
    const w = await world();
    const s0 = observe(w);
    expect(flows(s0, observe(w))).toEqual({});

    w.script([say("Nothing to say.")]);
    const thread = (await w.cli("send", "Look at it.")).out.trim();
    const s1 = observe(w);
    expect(flows(s0, s1)).toEqual({ in: 1 });

    await w.drain();
    const s2 = observe(w);
    expect(flows(s1, s2)).toEqual({ claim: 1 });

    w.script([call("notify", { body: "Done." }), say("Done.")]);
    await w.cli("send", "--to", thread, "Tell me when done.");
    await w.drain();
    const s3 = observe(w);
    expect(flows(s2, s3)).toEqual({ in: 1, claim: 1, calls: 1, says: 1 });

    await w.dispatch();
    const s4 = observe(w);
    expect(flows(s3, s4)).toEqual({ delivered: 1 });
    expect(s4.edges.delivered).toEqual({ total: 1, last24h: 1 });
    expect(flows(s4, observe(w))).toEqual({});
  });
});

describe("serve heartbeat", () => {
  test("serve records it on its nudge, and the snapshot says offline once it is older than 15 s", async () => {
    const w = await world();
    expect(observe(w).serve.state).toBe("never");

    let stop = () => {};
    const serving = serve(w.agent, new Promise<void>((resolve) => (stop = resolve)));
    const started = w.clock.now();
    await until(() => observe(w).serve.seenAt === started, "the first heartbeat");
    expect(observe(w).serve).toMatchObject({ state: "running", startedAt: started });

    await w.clock.timerDueBy(started + 5_000);
    w.advance(5_000);
    await until(() => observe(w).serve.seenAt === started + 5_000, "the heartbeat on the nudge");
    stop();
    await serving;

    const seen = started + 5_000;
    expect(observe(w).nextChangeAt).toBe(seen + 15_001);
    w.advance(seen + 15_000 - w.clock.now());
    expect(observe(w).serve.state).toBe("running");
    w.advance(1);
    expect(observe(w).serve).toMatchObject({ state: "offline", startedAt: started, seenAt: seen });
  });
});
