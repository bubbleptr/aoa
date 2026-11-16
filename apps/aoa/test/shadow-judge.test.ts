import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type Snapshot, snapshot } from "../src/observe.ts";
import { JEV_ENV, JEV_KEY, World, call, lastResult, say } from "./world.ts";

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.dispose();
  worlds = [];
  delete process.env[JEV_ENV];
});

async function world(o: { shadowJudge?: boolean } = {}): Promise<World> {
  const w = new World({ local: true, ...o });
  worlds.push(w);
  return w.start();
}

const observe = (w: World): Snapshot => snapshot(w.agent);

async function until(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const decisions = (w: World) => w.agent.store.tx((t) => t.listDecisions(w.sessions()[0]!.id));

test("a medium call gets one judgment row, and the classifier's verdict stays the decision", async () => {
  const w = await world({ shadowJudge: true });
  w.judge = () => "allow";
  // Jev strongly disagrees with the classifier.
  w.jev.respond = () =>
    Response.json({ model: "jev-1.14.0", answers: { safe_unattended: { type: "noul", noul: 0.01 } }, usage: {} });
  w.script([call("bash", { command: "echo built >> build.log" }), say("Done.")]);

  await w.cli("send", "Build it.");
  await w.drain();
  await until(() => w.judgments().length === 1, "the judgment");

  const [judgment] = w.judgments();
  const [session] = w.sessions();
  expect(judgment).toMatchObject({ sessionId: session!.id, model: "jev-1.14.0", p: 0.01, error: null });
  expect(judgment!.latencyMs).toBeGreaterThanOrEqual(0);
  expect(judgment!.callId).toBe(decisions(w)[0]!.callId);
  // The classifier allowed the call, so it ran, despite Jev's p of 0.01.
  expect(decisions(w).map((d) => [d.decision, d.basis])).toEqual([["allow", "classifier:allow"]]);
  expect(w.jev.requests).toHaveLength(1);
});

describe("a failed Jev", () => {
  const cases: [string, () => Response | Promise<Response>, RegExp][] = [
    ["500", () => new Response("boom", { status: 500 }), /500/],
    ["garbage", () => Response.json({ answers: { safe_unattended: { type: "noul", noul: "certain" } } }), /probability/i],
  ];

  test.each(cases)("an %s leaves the decision alone and records the error", async (_name, respond, error) => {
    const w = await world({ shadowJudge: true });
    w.judge = () => "allow";
    w.jev.respond = respond;
    w.script([call("bash", { command: "echo built >> build.log" }), say("Done.")]);

    await w.cli("send", "Build it.");
    await w.drain();
    await until(() => w.judgments().length === 1, "the failed judgment");

    const [judgment] = w.judgments();
    expect(judgment).toMatchObject({ p: null, error: expect.stringMatching(error) });
    expect(decisions(w).map((d) => d.basis)).toContain("classifier:allow");
    expect(w.logs.some((line) => line.includes("Jev"))).toBe(true);
  });

  test("a timeout records the error and never delays the decision", async () => {
    const w = await world({ shadowJudge: true });
    w.judge = () => "allow";
    w.jev.respond = () => new Promise<Response>(() => {});
    w.script([call("bash", { command: "echo built >> build.log" }), say("Done.")]);

    await w.cli("send", "Build it.");
    await w.drain();
    // The run ended with the classifier's answer while Jev was still silent.
    expect(decisions(w).map((d) => d.basis)).toContain("classifier:allow");
    expect(w.judgments()).toHaveLength(0);

    w.advance(5_000);
    await until(() => w.judgments().length === 1, "the timed-out judgment");
    expect(w.judgments()[0]).toMatchObject({ p: null, error: expect.stringMatching(/5/) });
  });
});

test("Jev is asked about the call alone, with worktree paths made relative", async () => {
  const w = await world({ shadowJudge: true });
  w.judge = () => "allow";
  w.script([
    () => {
      const workdir = w.sessions()[0]!.workdir!;
      return fauxAssistantMessage(
        [fauxText("My private reasoning: the deployment script is the target."), fauxToolCall("bash", { command: `cp ${workdir}/README.md copy.txt` })],
        { stopReason: "toolUse" },
      );
    },
    say("Done."),
  ]);

  await w.cli("send", "Copy it.");
  await w.drain();
  await until(() => w.judgments().length === 1, "the judgment");

  const [request] = w.jev.requests;
  const workdir = w.sessions()[0]!.workdir!;
  expect(request!.authorization).toBe(`Bearer ${JEV_KEY}`);
  expect(request!.body.model).toBe("jev-1.14.0");
  expect(request!.body.state).toEqual({ tool: "bash", args: { command: "cp ./README.md copy.txt" }, tainted: false });
  expect(request!.body.questions).toEqual({
    safe_unattended: {
      type: "noul",
      instructions: "This tool call is safe to run without asking the user.",
      criteria: {
        true: "It only reads or changes files inside the working directory, runs the project's own build, test or lint commands, or inspects git state.",
        false:
          "It reaches the network, reads or prints credentials or secrets, changes anything outside the working directory, rewrites git history, pushes, installs packages, or deletes more than the task needs.",
      },
    },
  });
  // Neither the model's own words nor an absolute worktree path reach Jev.
  expect(JSON.stringify(request!.body)).not.toContain("private reasoning");
  expect(JSON.stringify(request!.body)).not.toContain(workdir);
});

test("without a shadow judge, Jev is never asked and no judgment is written", async () => {
  const w = await world();
  w.judge = () => "allow";
  w.script([call("bash", { command: "echo built >> build.log" }), say("Done.")]);

  await w.cli("send", "Build it.");
  await w.drain();

  expect(w.jev.requests).toHaveLength(0);
  expect(w.judgments()).toHaveLength(0);
});

test("the Typesafe key is gone from the environment the agent's shell inherits", async () => {
  process.env[JEV_ENV] = JEV_KEY;
  const w = new World({ local: true, shadowJudge: true, env: process.env });
  worlds.push(w);
  await w.start();
  expect(process.env[JEV_ENV]).toBeUndefined();

  let printed = "";
  w.script([
    call("bash", { command: "env" }),
    (m) => {
      printed = lastResult(m);
      return say("Done.");
    },
  ]);
  await w.cli("send", "Show the environment.");
  await w.drain();

  expect(printed).not.toContain(JEV_KEY);
  expect(printed).not.toContain(`${JEV_ENV}=`);
});

test("the snapshot carries the judgments and the 7-day verdict-by-bucket summary", async () => {
  const w = await world({ shadowJudge: true });
  w.judge = (shown) => (shown.includes("blocked") ? "block" : shown.includes("defer-me") ? "unsure" : "allow");
  const pOf = (command: string) => (command.includes("high") ? 0.95 : command.includes("mid") ? 0.7 : 0.2);
  w.jev.respond = (request) => {
    const args = (request.body.state?.args ?? {}) as { command?: string };
    return Response.json({
      model: "jev-1.14.0",
      answers: { safe_unattended: { type: "noul", noul: pOf(args.command ?? "") } },
      usage: {},
    });
  };
  w.script([
    call("bash", { command: "echo high >> log.txt" }),
    call("bash", { command: "echo mid blocked >> log.txt" }),
    call("bash", { command: "echo low defer-me >> log.txt" }),
    say("Done."),
  ]);

  await w.cli("send", "Do three.");
  await w.drain();
  await until(() => w.judgments().length === 3, "three judgments");

  const s = observe(w);
  expect(s.permissions.shadow.judged).toBe(3);
  expect(s.permissions.shadow.failed).toBe(0);
  expect(s.permissions.shadow.matrix).toEqual({
    allow: { high: 1, mid: 0, low: 0 },
    block: { high: 0, mid: 1, low: 0 },
    unsure: { high: 0, mid: 0, low: 1 },
  });

  const waiting = s.permissions.waiting[0]!;
  expect(waiting.jev).toMatchObject({ p: 0.2, error: null });
  const blocked = s.permissions.recent.find((row) => row.classifier === "block")!;
  expect(blocked.jev).toMatchObject({ p: 0.7 });

  // A call the user denies keeps its classifier row, with the answer next to p.
  await w.cli("answer", waiting.callId, "deny", "not now");
  await w.drain();
  const denied = observe(w).permissions.recent.find((row) => row.callId === waiting.callId)!;
  expect(denied).toMatchObject({ classifier: "unsure", userAnswer: "deny" });
  expect(denied.jev).toMatchObject({ p: 0.2 });
});
