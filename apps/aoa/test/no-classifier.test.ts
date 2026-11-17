import { afterEach, expect, test } from "bun:test";
import { USER, World, call, say } from "./world.ts";

let w: World;
afterEach(() => w.dispose());

test("without a classifier, an untainted session's first ordinary command already waits for the user", async () => {
  w = await new World({ classifier: false }).start();
  w.gh.addIssue({ author: USER, title: "Commit and test", body: "", labels: ["aoa"] });
  w.script([call("bash", { command: 'git commit --allow-empty -m "x"' }), call("bash", { command: "bun test" }), say("Done.")]);
  await w.poll();
  await w.drain();

  const [session] = w.sessions();
  expect(session).toMatchObject({ tainted: false, status: "paused" });
  expect(w.runs().map((r) => r.end?.kind)).toEqual(["deferred"]);
  const decisions = w.agent.store.tx((t) => t.listDecisions(session!.id));
  expect(decisions.map((d) => [d.tool, d.decision, d.basis])).toEqual([["bash", "defer", "reviewer:missing"]]);
  // The run stopped at the commit; `bun test` was never even proposed.
  expect(w.pendingSteps()).toBe(2);
});

test("serve refuses a config without a classifier and says why; the other commands still work", async () => {
  w = await new World({ classifier: false }).start();
  const served = await w.cli("serve");
  expect(served.code).toBe(1);
  expect(served.err).toMatch(/^Invalid config: classifier .*required.*serve/);
  expect(served.err).toContain("bash");

  expect((await w.cli("status")).code).toBe(0);
  expect((await w.cli("send", "A task")).code).toBe(0);
  expect((await w.cli("answer", "nothing", "approve")).err).toContain("No pending call");
});
