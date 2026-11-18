import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The SDK as another repository gets it: the three packages packed as they would be published, installed into an empty
 * directory outside this workspace, with nothing else of aoa around. pi is an optional peer, so it is not installed.
 */
const repo = join(import.meta.dir, "..", "..", "..");
const PUBLISHED = ["kernel", "store-sqlite", "sdk"];
const dir = mkdtempSync(join(tmpdir(), "aoa-consumer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test("a program outside the workspace installs the packed SDK, runs, and typechecks without pi", () => {
  const tarballs: Record<string, string> = {};
  for (const name of PUBLISHED) {
    const packed = run([process.execPath, "pm", "pack", "--destination", dir, "--quiet"], join(repo, "packages", name));
    expect(packed.err).toBe("");
    const file = readdirSync(dir).find((f) => f.startsWith(`aoa-dev-${name}-`) && f.endsWith(".tgz"))!;
    tarballs[`@aoa-dev/${name}`] = `file:./${file}`;
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: tarballs, overrides: tarballs }),
  );
  cpSync(join(import.meta.dir, "fixtures", "consumer", "main.ts"), join(dir, "main.ts"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", strict: true, noEmit: true, types: ["bun"], typeRoots: [join(repo, "node_modules", "@types")], allowImportingTsExtensions: true, skipLibCheck: true },
      include: ["main.ts"],
    }),
  );

  const installed = run([process.execPath, "install"], dir);
  expect(installed.code).toBe(0);
  expect(readdirSync(join(dir, "node_modules")).filter((d) => d !== "@aoa-dev" && d !== ".bin" && !d.startsWith("."))).toEqual([]);

  const ran = run([process.execPath, "main.ts"], dir);
  expect(ran.err).toBe("");
  expect(JSON.parse(ran.out)).toEqual([["sent", "got 1 event(s)"]]);

  const typed = run([join(repo, "node_modules", ".bin", "tsc"), "-p", "."], dir);
  expect(typed.out).toBe("");
  expect(typed.code).toBe(0);
}, 120_000);
