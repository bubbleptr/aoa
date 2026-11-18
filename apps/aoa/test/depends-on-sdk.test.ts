import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const root = join(import.meta.dir, "..");

test("the app reaches the kernel and SQLite store only through @aoa-dev/sdk, and src never bypasses Host/Agent", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(Object.keys(pkg.dependencies)).not.toContain("@aoa-dev/kernel");
  expect(Object.keys(pkg.dependencies)).not.toContain("@aoa-dev/store-sqlite");
  const offenders = [...new Glob("{src,test,eval}/**/*.ts").scanSync(root)].filter((f) => {
    if (f.endsWith("depends-on-sdk.test.ts")) return false;
    const text = readFileSync(join(root, f), "utf8");
    return /from "@aoa-dev\/(kernel|store-sqlite|sdk\/kernel)"|packages\/sdk\/src\/(kernel|sqlite)/.test(text);
  });
  expect(offenders).toEqual([]);

  const srcBypasses = [...new Glob("src/**/*.ts").scanSync(root)].filter((f) =>
    /\.tx\(|\btype\s+Tx\b|\blastBeat\(|\bfollowTools\b|\bstore\.db\b/.test(readFileSync(join(root, f), "utf8")),
  );
  expect(srcBypasses).toEqual([]);
});
