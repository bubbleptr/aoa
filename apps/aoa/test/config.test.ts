import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePaths, findConfig, validateConfig } from "../src/config.ts";

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
    expect(validateConfig(valid).github?.appId).toBe("4242");
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

describe("local mode", () => {
  const { github: _, ...local } = valid;

  test("a config without github is valid", () => {
    expect(validateConfig(local).github).toBeUndefined();
  });

  test("the inbox is named after the repo directory, and memory and worktrees follow it", () => {
    const paths = derivePaths(validateConfig({ ...local, repo: { path: "~/code/widgets/", base: "main" } }), "/home/k");
    expect(paths).toMatchObject({
      inboxId: "local/widgets",
      memory: "/home/k/.aoa/memory/local/widgets",
      worktrees: "/home/k/.aoa/worktrees/local/widgets",
      repo: "/home/k/code/widgets",
      privateKey: null,
    });
  });
});

describe("shadow judge", () => {
  const judge = { provider: "typesafe", modelId: "jev-1.14.0", apiKeyEnv: "TYPESAFE_API_KEY" };

  test("is optional and takes the same shape as the classifier", () => {
    expect(validateConfig({ ...valid, shadowJudge: judge }).shadowJudge).toEqual(judge);
    expect(validateConfig(valid).shadowJudge).toBeUndefined();
  });

  test("must be the provider this app knows how to call", () => {
    expect(() => validateConfig({ ...valid, shadowJudge: { ...judge, provider: "other" } })).toThrow(
      /^Invalid config: shadowJudge\.provider must be typesafe/,
    );
  });

  test("names a missing field", () => {
    expect(() => validateConfig({ ...valid, shadowJudge: { provider: "typesafe" } })).toThrow(/shadowJudge\.modelId/);
  });
});

describe("where the config is found", () => {
  const dirs = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "aoa-config-")));
    const cwd = join(root, "project");
    const home = join(root, "home");
    mkdirSync(cwd);
    mkdirSync(join(home, ".aoa"), { recursive: true });
    return { root, cwd, home, local: join(cwd, "aoa.config.ts"), global: join(home, ".aoa", "aoa.config.ts") };
  };

  test("the current directory's config wins over the one in ~/.aoa, and --config over both", () => {
    const d = dirs();
    writeFileSync(d.local, "");
    writeFileSync(d.global, "");
    expect(findConfig(undefined, d.cwd, d.home)).toBe(d.local);
    expect(findConfig("other/x.ts", d.cwd, d.home)).toBe(join(d.cwd, "other", "x.ts"));
    rmSync(d.root, { recursive: true });
  });

  test("from a directory with no config, the one in ~/.aoa is used", () => {
    const d = dirs();
    writeFileSync(d.global, "");
    expect(findConfig(undefined, d.cwd, d.home)).toBe(d.global);
    rmSync(d.root, { recursive: true });
  });

  test("with no config anywhere the error names both places", () => {
    const d = dirs();
    expect(() => findConfig(undefined, d.cwd, d.home)).toThrow(d.local);
    expect(() => findConfig(undefined, d.cwd, d.home)).toThrow(d.global);
    rmSync(d.root, { recursive: true });
  });
});
