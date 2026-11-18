import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@aoa-dev/conformance";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { sqliteStore } from "@aoa-dev/store-sqlite";
import { createTui } from "../src/index.ts";

const opened: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "aoa-tui-"));
  dirs.push(dir);
  writeFileSync(join(dir, "hello.txt"), "hello from disk\n");
  const store = sqliteStore(":memory:");
  opened.push(store);
  const clock = new FakeClock();
  const faux = fauxProvider({ provider: "scripted", models: [{ id: "m" }] });
  let out = "";
  const tui = createTui({
    store,
    provider: "scripted",
    modelId: "m",
    providers: [faux.provider],
    cwd: dir,
    dataDir: join(dir, ".aoa-tui"),
    clock,
    write: (chunk) => {
      out += chunk;
    },
  });
  const drain = async () => {
    await tui.agent.step.worker();
    await tui.agent.step.dispatcher();
  };
  return { dir, clock, faux, tui, drain, output: () => out };
}

test("streams assistant text and runs low-risk read without asking", async () => {
  const h = harness();
  h.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The file says: hello from disk."),
  ]);

  expect(h.tui.handleLine("what is in hello.txt?")).toBe("handled");
  await h.drain();

  expect(h.output()).toContain("→ read");
  expect(h.output()).toContain("The file says: hello from disk.");
  expect(h.tui.agent.read.pending()).toEqual([]);
  expect(h.tui.agent.read.outbox({ status: "sent" }).map((m) => m.body)).toEqual(["The file says: hello from disk."]);
});

test("pauses a mutating write for /y, queues chat typed meanwhile without denying, and runs once approved", async () => {
  const h = harness();
  const seenPrompts: string[] = [];
  h.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "out.txt", content: "v1\n" }), { stopReason: "toolUse" }),
    (ctx) => {
      seenPrompts.push(JSON.stringify(ctx.messages));
      return fauxAssistantMessage("Wrote out.txt and noted your extra remark.");
    },
  ]);

  h.tui.handleLine("create out.txt");
  await h.drain();

  expect(h.output()).toContain("? [approval] write");
  expect(h.tui.agent.read.pending()).toHaveLength(1);

  // Typing a normal chat line before `/y` queues it rather than denying the pending write.
  h.tui.handleLine("also remember we are on v1");
  await h.drain();
  expect(h.tui.agent.read.pending()).toHaveLength(1);

  h.tui.handleLine("/y");
  await h.drain();

  expect(h.tui.agent.read.pending()).toEqual([]);
  expect(seenPrompts[0]).toContain("also remember we are on v1");
  expect(h.output()).toContain("Wrote out.txt and noted your extra remark.");
});

test("runs through pi in a child process with no git on PATH and outside any git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aoa-tui-nogit-"));
  dirs.push(dir);
  const piAi = Bun.fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const sqlite = Bun.fileURLToPath(import.meta.resolve("@aoa-dev/store-sqlite"));
  const tuiEntry = join(import.meta.dir, "../src/index.ts");
  const script = `
    import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(piAi)};
    import { sqliteStore } from ${JSON.stringify(sqlite)};
    import { createTui } from ${JSON.stringify(tuiEntry)};
    const faux = fauxProvider({ provider: "scripted", models: [{ id: "m" }] });
    faux.setResponses([fauxAssistantMessage("works without git")]);
    let out = "";
    const tui = createTui({
      store: sqliteStore(":memory:"),
      provider: "scripted",
      modelId: "m",
      providers: [faux.provider],
      cwd: ${JSON.stringify(dir)},
      dataDir: ${JSON.stringify(join(dir, "state"))},
      write: (c) => (out += c),
    });
    tui.handleLine("ping");
    await tui.agent.step.worker();
    await tui.agent.step.dispatcher();
    tui.host.close();
    if (!out.includes("works without git")) process.exit(2);
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: dir,
    env: { HOME: dir, TMPDIR: dir, PATH: "" },
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
});
