import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, ScriptedRuntime } from "@aoa-dev/conformance";
import { systemClock } from "../src/kernel/index.ts";
import { sqliteStore } from "../src/index.ts";
import { createHost } from "../src/index.ts";

const dirs: string[] = [];
const closing: { close(): void }[] = [];
afterEach(() => {
  for (const c of closing.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dbFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "aoa-serving-"));
  dirs.push(dir);
  return join(dir, "aoa.db");
};

/** Appends one event to `db` from a separate process, as `aoa send` does. */
async function writeFromAnotherProcess(db: string): Promise<void> {
  const script = `
    import { sqliteStore } from "../src/index.ts";
    import { appendEvent, systemClock } from "../src/kernel/index.ts";
    const store = sqliteStore(${JSON.stringify(db)});
    appendEvent({ store, clock: systemClock, inboxId: "in" }, { source: "user_message", dedupeKey: "from-outside", payload: { text: "hi" }, thread: "t", trusted: true });
    store.close();
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

for (const files of [true, false]) {
  test(`watch sees another process's commit within a second${files ? "" : ", with the file watch missing it"}`, async () => {
    const db = dbFile();
    const store = sqliteStore(db, { watchFile: files });
    const host = createHost({ store, clock: systemClock, log: () => {} });
    closing.push(host);
    let seen = 0;
    const stop = host.watch(() => seen++);

    await writeFromAnotherProcess(db);
    // The writer has exited, so its commit is in.
    const wrote = Date.now();
    while (seen === 0 && Date.now() - wrote < 2000) await Bun.sleep(10);
    expect(seen).toBeGreaterThan(0);
    expect(Date.now() - wrote).toBeLessThan(1000 + 200);
    stop();
  }, 10_000);
}

test("watch reports this process's own commits, also on a store with no file", async () => {
  const store = sqliteStore(":memory:");
  const host = createHost({ store, clock: new FakeClock(), log: () => {} });
  closing.push(host);
  const agent = host.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  let seen = 0;
  host.watch(() => seen++);
  agent.append({ source: "user_message", dedupeKey: "k", payload: null, thread: "t", trusted: true });
  await Bun.sleep(0);
  expect(seen).toBe(1);
  // A read commits nothing.
  agent.read.events();
  await Bun.sleep(0);
  expect(seen).toBe(1);
});

test("a started host wakes its worker for another process's event, with no nudge", async () => {
  const db = dbFile();
  const store = sqliteStore(db);
  const host = createHost({ store, clock: systemClock, log: () => {} });
  closing.push(host);
  const runtime = new ScriptedRuntime();
  host.agent({ name: "a", inbox: "in", runtime, debounceMs: 0 });
  host.start();
  await writeFromAnotherProcess(db);
  await runtime.started(1);
  await host.stop();
}, 10_000);

test("a second host on the same store cannot start while the first serves; serving() names the first", async () => {
  const db = dbFile();
  const clock = new FakeClock();
  const first = createHost({ store: sqliteStore(db), clock, log: () => {} });
  const second = createHost({ store: sqliteStore(db), clock, log: () => {} });
  closing.push(first, second);
  first.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  second.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });

  expect(second.serving()).toBeNull();
  first.start();
  expect(() => second.start()).toThrow(new RegExp(`pid ${process.pid}`));
  expect(second.serving()).toEqual({ pid: process.pid, since: clock.now() });

  // The heartbeat keeps it serving; without one for 15 seconds it is not.
  clock.advance(14_000);
  expect(second.serving()).not.toBeNull();
  await first.stop();
  clock.advance(16_000);
  expect(second.serving()).toBeNull();

  const third = createHost({ store: sqliteStore(db), clock, log: () => {} });
  closing.push(third);
  third.agent({ name: "a", inbox: "in", runtime: new ScriptedRuntime() });
  third.start();
  await third.stop();
});

test("the lock goes with the process that held it", async () => {
  const db = dbFile();
  const script = `
    import { sqliteStore } from "../src/index.ts";
    sqliteStore(${JSON.stringify(db)}).lock();
    process.stdout.write("locked\\n");
    await Bun.sleep(60_000);
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, stdout: "pipe" });
  const reader = proc.stdout.getReader();
  await reader.read();
  expect(() => sqliteStore(db).lock()).toThrow();
  proc.kill(9);
  await proc.exited;
  const store = sqliteStore(db);
  closing.push(store);
  const lock = store.lock()!;
  lock.release();
}, 10_000);
