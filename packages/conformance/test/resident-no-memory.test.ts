import { expect, test } from "bun:test";
import { buildResident } from "@aoa-dev/kernel";

test("an agent without memory is told nothing about memory files, progress files or code", async () => {
  const text = await buildResident(undefined, "s1", []);
  expect(text).toContain("Stay quiet unless");
  for (const word of [/memory/i, /progress/i, /pull request/i, /commit/i, /instructions\.md/]) expect(text).not.toMatch(word);
});

test("with memory, pointers are for anything that can be looked up again, not only code", async () => {
  const { RESIDENT_PREAMBLE } = await import("@aoa-dev/kernel");
  expect(RESIDENT_PREAMBLE).not.toMatch(/pull request|commit/i);
  expect(RESIDENT_PREAMBLE).toContain("store a pointer");
});
