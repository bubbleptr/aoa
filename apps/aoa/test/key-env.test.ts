import { afterEach, expect, test } from "bun:test";
import { KEY_ENV, MODEL_KEY, USER, World, call, lastResult, say } from "./world.ts";

let w: World;
afterEach(() => {
  w.dispose();
  delete process.env[KEY_ENV];
  delete process.env.AOA_TEST_UNRELATED;
});

test("once assembled, the model key is gone from the environment the agent's shell inherits", async () => {
  process.env[KEY_ENV] = MODEL_KEY;
  process.env.AOA_TEST_UNRELATED = "still-here";
  w = await new World({ env: process.env }).start();
  expect(process.env[KEY_ENV]).toBeUndefined();
  expect(process.env.AOA_TEST_UNRELATED).toBe("still-here");

  let printed = "";
  w.gh.addIssue({ author: USER, title: "Show the environment", body: "", labels: ["aoa"] });
  w.script([
    call("bash", { command: "env" }),
    (m) => {
      printed = lastResult(m);
      return say("Done.");
    },
  ]);
  await w.poll();
  await w.drain();

  expect(printed).toContain("AOA_TEST_UNRELATED=still-here");
  expect(printed).not.toContain(MODEL_KEY);
  expect(printed).not.toContain(`${KEY_ENV}=`);
});
