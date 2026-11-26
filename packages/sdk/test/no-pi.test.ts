import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

/** The SDK carries no runtime of a particular vendor: pi lives in `@aoa-dev/pi`, outside the published package. */
test("@aoa-dev/sdk neither imports nor declares pi", () => {
  const root = join(import.meta.dir, "..");
  const pkg = readFileSync(join(root, "package.json"), "utf8");
  expect(pkg).not.toContain("@earendil-works");
  const offenders = [...new Glob("src/**/*.ts").scanSync(root)].filter((f) => readFileSync(join(root, f), "utf8").includes("@earendil-works"));
  expect(offenders).toEqual([]);
});
