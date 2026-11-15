import { describe, expect, test } from "bun:test";
import { derivePaths, validateConfig } from "../src/config.ts";

const valid = {
  dataDir: "~/.aoa",
  repo: { path: "~/code/widgets", base: "main" },
  model: { provider: "anthropic", modelId: "claude-x", apiKeyEnv: "ANTHROPIC_API_KEY" },
  github: {
    owner: "acme",
    repo: "widgets",
    label: "aoa",
    userLogin: "kieran",
    botLogin: "aoa-agent[bot]",
    appId: 4242,
    installationId: "777",
    privateKeyPath: "~/.aoa/app.pem",
  },
};

const without = (path: string[]) => {
  const copy = structuredClone(valid) as Record<string, any>;
  let at = copy;
  for (const k of path.slice(0, -1)) at = at[k];
  delete at[path.at(-1)!];
  return copy;
};

describe("validateConfig", () => {
  test("accepts a complete config and takes numeric App ids as strings", () => {
    expect(validateConfig(valid).github.appId).toBe("4242");
  });

  test.each([
    [without(["github", "userLogin"]), "github.userLogin"],
    [without(["repo", "base"]), "repo.base"],
    [{ ...valid, model: { ...valid.model, apiKeyEnv: "" } }, "model.apiKeyEnv"],
    [{ ...valid, classifier: { provider: "anthropic" } }, "classifier.modelId"],
    [{ ...valid, risk: { bash: "none" } }, "risk.bash"],
    [{ ...valid, rate: { maxMsgs: 0, windowMs: 1000, minIntervalMs: 0 } }, "rate.maxMsgs"],
    [{ ...valid, stroe: "x" }, "stroe"],
    [{ ...valid, github: { ...valid.github, token: "ghp_x" } }, "github.token"],
    [null, "config"],
  ])("names the bad field: %#", (raw, field) => {
    expect(() => validateConfig(raw)).toThrow(new RegExp(`^Invalid config: ${field.replace(".", "\\.")}\\b`));
  });
});

test("paths are derived from dataDir and the repo, with ~ expanded", () => {
  const paths = derivePaths(validateConfig(valid), "/home/k");
  expect(paths).toEqual({
    inboxId: "acme/widgets",
    dataDir: "/home/k/.aoa",
    db: "/home/k/.aoa/aoa.db",
    memory: "/home/k/.aoa/memory/acme/widgets",
    sessions: "/home/k/.aoa/sessions",
    piAgent: "/home/k/.aoa/pi",
    worktrees: "/home/k/.aoa/worktrees/acme/widgets",
    repo: "/home/k/code/widgets",
    privateKey: "/home/k/.aoa/app.pem",
  });
});
