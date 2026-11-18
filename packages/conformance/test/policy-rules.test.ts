import { describe, expect, test } from "bun:test";
import { decide, type PolicyConfig, type PolicyContext } from "../src/kernel.ts";

const clean: PolicyContext = { tainted: false, workdir: null };

describe("decision order", () => {
  const call = { tool: "deploy", args: {} };

  test("without a policy a call still goes by its tool's tier: unknown waits, low runs, medium waits for the missing reviewer", async () => {
    expect(await decide(undefined, call, clean)).toEqual({ decision: "defer", basis: "risk:high" });
    expect(await decide(undefined, call, clean, "low")).toEqual({ decision: "allow", basis: "risk:low" });
    expect(await decide(undefined, call, clean, "medium")).toEqual({ decision: "defer", basis: "reviewer:missing" });
  });

  test("an unlisted tool is high risk and waits", async () => {
    expect(await decide({ risk: {} }, call, clean)).toMatchObject({ decision: "defer", basis: "risk:high" });
  });

  test("a medium tool goes to the classifier; unsure, throwing or missing means wait", async () => {
    const withClassifier = (classify: PolicyConfig["classify"]): PolicyConfig => ({ risk: { deploy: "medium" }, classify });
    expect(await decide(withClassifier(async () => "allow"), call, clean)).toMatchObject({ decision: "allow", basis: "reviewer:allow" });
    expect(await decide(withClassifier(async () => "block"), call, clean)).toMatchObject({ decision: "block", basis: "reviewer:block" });
    expect(await decide(withClassifier(async () => "unsure"), call, clean)).toMatchObject({ decision: "defer", basis: "reviewer:unsure" });
    expect(
      await decide(withClassifier(async () => {
        throw new Error("model down");
      }), call, clean),
    ).toMatchObject({ decision: "defer", basis: "reviewer:error" });
    expect(await decide(withClassifier(undefined), call, clean)).toMatchObject({ decision: "defer", basis: "reviewer:missing" });
  });

  test("the classifier sees whether the session is tainted", async () => {
    const classify: PolicyConfig["classify"] = async (_call, ctx) => (ctx.tainted ? "unsure" : "allow");
    const p: PolicyConfig = { risk: { deploy: "medium" }, classify };
    expect((await decide(p, call, { tainted: false, workdir: null })).decision).toBe("allow");
    expect((await decide(p, call, { tainted: true, workdir: null })).decision).toBe("defer");
  });

  test("the first rule with an opinion wins over the risk tier", async () => {
    const p: PolicyConfig = {
      risk: { deploy: "low" },
      rules: [
        { name: "silent", match: () => null },
        { name: "freeze", match: (c) => (c.tool === "deploy" ? "block" : null) },
        { name: "late", match: () => "allow" },
      ],
    };
    expect(await decide(p, call, clean)).toMatchObject({ decision: "block", basis: "rule:freeze" });
  });
});
