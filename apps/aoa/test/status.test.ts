import { describe, expect, test } from "bun:test";
import { formatDuration, outcome, resolveCallId } from "../src/status.ts";

describe("outcome (design §10)", () => {
  test.each([
    [{ pull: "merged", userEventsAfterPull: 0, sessionClosed: true }, "merged"],
    [{ pull: "merged", userEventsAfterPull: 2, sessionClosed: true }, "reworked"],
    [{ pull: "closed", userEventsAfterPull: 0, sessionClosed: true }, "discarded"],
    [{ pull: "closed", userEventsAfterPull: 1, sessionClosed: false }, "discarded"],
    [{ pull: null, userEventsAfterPull: 0, sessionClosed: true }, "discarded"],
    [{ pull: null, userEventsAfterPull: 0, sessionClosed: false }, "in progress"],
    [{ pull: "open", userEventsAfterPull: 3, sessionClosed: false }, "in progress"],
    [{ pull: "unknown", userEventsAfterPull: 0, sessionClosed: true }, "in progress"],
  ] as const)("%j is %s", (input, expected) => {
    expect(outcome(input)).toBe(expected);
  });
});

describe("resolveCallId", () => {
  const ids = ["3f2a91c0-aaaa:toolu_1", "3f2b0000-bbbb:toolu_2", "9c11ffff-cccc:call_0"];

  test("a unique prefix or an exact id resolves", () => {
    expect(resolveCallId(ids, "9c")).toBe("9c11ffff-cccc:call_0");
    expect(resolveCallId(ids, "3f2a")).toBe("3f2a91c0-aaaa:toolu_1");
    expect(resolveCallId([...ids, "3f2a91c0-aaaa:toolu_1x"], "3f2a91c0-aaaa:toolu_1")).toBe("3f2a91c0-aaaa:toolu_1");
  });

  test("an ambiguous prefix names the candidates", () => {
    expect(() => resolveCallId(ids, "3f2")).toThrow(/ambiguous.*3f2a91c0-aaaa:toolu_1.*3f2b0000-bbbb:toolu_2/s);
  });

  test("an unknown prefix lists every pending call", () => {
    expect(() => resolveCallId(ids, "zz")).toThrow(/No pending call matches "zz".*9c11ffff-cccc:call_0/s);
    expect(() => resolveCallId([], "zz")).toThrow(/No pending call matches "zz".*none/s);
  });
});

test("durations read in the two largest units", () => {
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(3 * 60_000 + 5_000)).toBe("3m 05s");
  expect(formatDuration(2 * 3_600_000 + 7 * 60_000)).toBe("2h 07m");
  expect(formatDuration(26 * 3_600_000)).toBe("1d 02h");
});
