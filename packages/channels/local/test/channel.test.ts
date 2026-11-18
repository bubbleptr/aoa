import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutMsg } from "@aoa/kernel";
import { darwinNotifyArgv, localChannel } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "aoa-local-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `messages-${n++}.md`);

const msg = (o: Partial<OutMsg> = {}): OutMsg => ({
  id: "m1",
  inboxId: "local/widgets",
  sessionId: "s1",
  thread: "local:0a1b2c3d",
  kind: "message",
  body: "Committed on aoa/12345678.",
  callId: null,
  dedupeKey: "msg:s1:c1",
  createdAt: Date.UTC(2026, 10, 16, 9, 30),
  status: "sending",
  attempts: 0,
  ...o,
});

describe("deliver", () => {
  test("appends a readable entry and notifies once; delivering it again adds nothing", async () => {
    const file = fresh();
    const notes: [string, string][] = [];
    const channel = localChannel({ file, notify: async (title, body) => void notes.push([title, body]) });
    await channel.deliver(msg());
    const once = readFileSync(file, "utf8");
    expect(once).toContain("Committed on aoa/12345678.");
    expect(once).toContain("local:0a1b2c3d");
    expect(once).toContain("2026-11-16T09:30:00.000Z");
    expect(once).toContain("<!-- aoa:msg:s1:c1 -->");
    expect(notes).toHaveLength(1);
    expect(notes[0]![1]).toContain("Committed on aoa/12345678.");

    await channel.deliver(msg());
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(notes).toHaveLength(1);

    await channel.deliver(msg({ id: "m2", dedupeKey: "msg:s1:c2", body: "Second." }));
    expect(readFileSync(file, "utf8").startsWith(once)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Second.");
    expect(notes).toHaveLength(2);
  });

  test("an approval request leaves the desktop notification to an open page that notifies, and names the page otherwise", async () => {
    const notes: [string, string][] = [];
    let page: { url: string; notifying: boolean } | null = { url: "http://127.0.0.1:7878", notifying: true };
    const channel = localChannel({ file: fresh(), notify: async (title, body) => void notes.push([title, body]), page: () => page });
    const ask = (n: number) => msg({ id: `a${n}`, kind: "approval_request", callId: `s1:t${n}`, dedupeKey: `approval:s1:t${n}`, body: "May I?" });

    await channel.deliver(ask(1));
    expect(notes).toHaveLength(0);
    await channel.deliver(msg());
    expect(notes).toHaveLength(1);

    page = { url: "http://127.0.0.1:7878", notifying: false };
    await channel.deliver(ask(2));
    expect(notes.at(-1)![1]).toContain("http://127.0.0.1:7878");

    page = null;
    await channel.deliver(ask(3));
    expect(notes).toHaveLength(3);
    expect(notes.at(-1)![1]).not.toContain("http://");
  });

  test("an approval request says how to answer it with aoa answer", async () => {
    const file = fresh();
    const channel = localChannel({ file });
    await channel.deliver(msg({ kind: "approval_request", callId: "s1:toolu_7", dedupeKey: "approval:s1:toolu_7", body: "May I?" }));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("aoa answer s1:toolu_7 approve");
    expect(text).toContain("aoa answer s1:toolu_7 deny <reason>");
  });

  test("a body quoting another message's marker cannot suppress that message", async () => {
    const file = fresh();
    const channel = localChannel({ file });
    await channel.deliver(msg({ body: "See <!-- aoa:msg:s1:c9 --> here." }));
    await channel.deliver(msg({ id: "m9", dedupeKey: "msg:s1:c9", body: "The real one." }));
    expect(readFileSync(file, "utf8")).toContain("The real one.");
  });

  test("a failing notifier is logged, never thrown, and the entry is written", async () => {
    const file = fresh();
    const logs: string[] = [];
    const channel = localChannel({
      file,
      notify: async () => {
        throw new Error("no display");
      },
      log: (line) => logs.push(line),
    });
    await channel.deliver(msg());
    expect(readFileSync(file, "utf8")).toContain("Committed on aoa/12345678.");
    expect(logs.join("\n")).toContain("no display");
  });

  test("creates the file's directory", async () => {
    const file = join(root, "nested", "dir", "messages.md");
    await localChannel({ file }).deliver(msg());
    expect(existsSync(file)).toBe(true);
  });
});

test("openThread returns a fresh local thread key each time", () => {
  const channel = localChannel({ file: fresh() });
  const a = channel.openThread();
  expect(a).toMatch(/^local:[0-9a-f]{8}$/);
  expect(channel.openThread()).not.toBe(a);
});

test("the darwin notifier passes the text as arguments, never inside the script", () => {
  const body = `"; do shell script "touch /tmp/pwned" --`;
  const title = "aoa: local:0a1b2c3d";
  const argv = darwinNotifyArgv(title, body);
  const script = argv.slice(0, argv.indexOf("-e") + 2).join(" ");
  expect(argv[0]).toBe("osascript");
  expect(script).not.toContain(body);
  expect(script).not.toContain(title);
  expect(argv.slice(argv.indexOf("-e") + 2)).toEqual([title, body]);
});

test("a body that looks like an option comes after the title, where option parsing has already stopped", () => {
  const body = "-e do shell script \"touch /tmp/pwned\"";
  const argv = darwinNotifyArgv("aoa (local:0a1b2c3d)", body);
  expect(argv.indexOf(body)).toBe(argv.length - 1);
  expect(argv[argv.length - 2]).toBe("aoa (local:0a1b2c3d)");
});
