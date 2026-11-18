import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a day runs through pi with no git on PATH and no repository around it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aoa-digest-nogit-"));
  const bin = mkdtempSync(join(tmpdir(), "aoa-digest-emptybin-"));
  dirs.push(cwd, bin);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "pi-day.ts")], {
    cwd,
    env: { PATH: bin, HOME: cwd, TMPDIR: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({
    jobInFirstRequest: true,
    runs: [{ end: "sent", error: null }],
    messages: [{ body: "#7 needs you", status: "sent" }],
  });
}, 30_000);

test("the example uses neither the coding tools nor a channel", () => {
  const src = join(import.meta.dir, "..", "src");
  for (const file of readdirSync(src)) {
    const text = readFileSync(join(src, file), "utf8");
    expect(text).not.toContain("@aoa/sdk/tools/coding");
    expect(text).not.toContain("@aoa/channel-");
  }
});
