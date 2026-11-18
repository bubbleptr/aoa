import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

/** Each example is built the way an SDK user would build it: on `@aoa-dev/sdk`, never on the kernel underneath. */
for (const name of readdirSync(import.meta.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(import.meta.dir, d.name, "package.json"))).map((d) => d.name)) {
  test(`examples/${name} reaches the kernel and SQLite store only through @aoa-dev/sdk`, () => {
    const root = join(import.meta.dir, name);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@aoa-dev/kernel");
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@aoa-dev/store-sqlite");
    const offenders = [...new Glob("{src,test}/**/*.ts").scanSync(root)].filter((f) =>
      /from "@aoa-dev\/(kernel|store-sqlite|sdk\/kernel)"|packages\/sdk\/src\/(kernel|sqlite)/.test(readFileSync(join(root, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
}
