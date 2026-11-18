import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const root = join(import.meta.dir, "..");

test("the app reaches the kernel only through the SDK", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(Object.keys(pkg.dependencies)).not.toContain("@aoa/kernel");
  const offenders = [...new Glob("{src,test,eval}/**/*.ts").scanSync(root)].filter((f) =>
    /from "@aoa\/kernel"/.test(readFileSync(join(root, f), "utf8")),
  );
  expect(offenders).toEqual([]);
});
