import { expect, test } from "bun:test";
import { githubIssues } from "../src/index.ts";

test("githubIssues asks for one page updated since the time given, leaves out pull requests, and sends the token", async () => {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetchFake = (async (url: URL, init: RequestInit) => {
    asked.push({ url: String(url), headers: init.headers as Record<string, string> });
    return Response.json([
      { number: 1, title: "Bug", html_url: "https://github.com/o/r/issues/1", state: "open", labels: [{ name: "bug" }], updated_at: "2026-11-18T07:00:00Z", body: null },
      { number: 2, title: "PR", html_url: "https://github.com/o/r/pull/2", state: "open", labels: [], updated_at: "2026-11-18T07:00:00Z", body: "", pull_request: {} },
    ]);
  }) as unknown as typeof fetch;
  const issues = await githubIssues({ owner: "o", repo: "r", token: "t0k", fetch: fetchFake }).updatedSince(Date.UTC(2026, 10, 17));

  expect(issues).toEqual([
    { number: 1, title: "Bug", url: "https://github.com/o/r/issues/1", state: "open", labels: ["bug"], updatedAt: Date.UTC(2026, 10, 18, 7), body: "" },
  ]);
  const { searchParams } = new URL(asked[0]!.url);
  expect(searchParams.get("since")).toBe("2026-11-17T00:00:00.000Z");
  expect(searchParams.get("per_page")).toBe("100");
  expect(asked[0]!.headers.authorization).toBe("Bearer t0k");
  expect(asked[0]!.headers["user-agent"]).toBe("aoa-example-digest");
});
