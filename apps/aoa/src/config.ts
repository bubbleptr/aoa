import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RatePolicy, Risk } from "@aoa/kernel";

export type ModelRef = {
  /** pi provider id, e.g. `anthropic`. */
  provider: string;
  modelId: string;
  /** The environment variable that holds the API key. The key itself never appears in the config. */
  apiKeyEnv: string;
};

export type Role = "implement" | "review";

/** A named agent with everything it did not set taken from the top level. */
export type NamedAgent = {
  role: Role;
  /** Appended to the role's system prompt. */
  instructions?: string;
  model: ModelRef;
  classifier?: ModelRef;
  risk?: Record<string, Risk>;
};

/** What a config file writes for one named agent. */
export type AgentInput = Partial<NamedAgent>;

export type AgentConfig = {
  dataDir: string;
  repo: { path: string; base: string };
  model: ModelRef;
  /** Judges `medium` calls; without one they wait for the user. Required by `serve`. */
  classifier?: ModelRef;
  /** Scores every classifier call with TypeSafe Jev but never changes the decision (design §12). */
  shadowJudge?: ModelRef;
  /** Absent: local mode, where tasks come from `aoa send` and work stays on local branches. */
  github?: {
    owner: string;
    repo: string;
    /** Default `aoa`. */
    label?: string;
    userLogin: string;
    botLogin: string;
    appId: string;
    installationId: string;
    privateKeyPath: string;
  };
  /** Per-tool risk, over the built-in table. */
  risk?: Record<string, Risk>;
  rate?: RatePolicy;
  /** Agents besides the default one, which the top-level fields describe. Local mode only. */
  agents?: Record<string, NamedAgent>;
};

type GitHubConfig = NonNullable<AgentConfig["github"]>;

/** What a config file writes; the App ids may be numbers. */
export type AgentConfigInput = Omit<AgentConfig, "github" | "agents"> & {
  agents?: Record<string, AgentInput>;
  github?: Omit<GitHubConfig, "appId" | "installationId"> & { appId: string | number; installationId: string | number };
};

export const defineAgent = (config: AgentConfigInput): AgentConfigInput => config;

export class ConfigError extends Error {
  constructor(field: string, problem: string) {
    super(`Invalid config: ${field} ${problem}`);
    this.name = "ConfigError";
  }
}

type Obj = Record<string, unknown>;

function object(value: unknown, field: string, keys: string[]): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(field, "must be an object");
  for (const k of Object.keys(value)) {
    // A typo or a secret pasted into the config should fail loudly, not be ignored.
    if (!keys.includes(k)) throw new ConfigError(field === "config" ? k : `${field}.${k}`, "is not a known setting");
  }
  return value as Obj;
}

function str(o: Obj, key: string, field: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${field}${key}`, "must be a non-empty string");
  return v;
}

function id(o: Obj, key: string, field: string): string {
  const v = o[key];
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  return str(o, key, field);
}

function modelRef(value: unknown, field: string): ModelRef {
  const o = object(value, field, ["provider", "modelId", "apiKeyEnv"]);
  const p = `${field}.`;
  return { provider: str(o, "provider", p), modelId: str(o, "modelId", p), apiKeyEnv: str(o, "apiKeyEnv", p) };
}

function nonNegative(o: Obj, key: string, field: string, positive = false): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (positive && v === 0)) {
    throw new ConfigError(`${field}${key}`, positive ? "must be a positive number" : "must be a number of at least 0");
  }
  return v;
}

function rate(value: unknown): RatePolicy {
  const o = object(value, "rate", ["maxMsgs", "windowMs", "minIntervalMs", "quietPeriod"]);
  const r: RatePolicy = {
    maxMsgs: nonNegative(o, "maxMsgs", "rate.", true),
    windowMs: nonNegative(o, "windowMs", "rate.", true),
    minIntervalMs: nonNegative(o, "minIntervalMs", "rate."),
  };
  if (o.quietPeriod !== undefined) {
    const q = object(o.quietPeriod, "rate.quietPeriod", ["startMinute", "endMinute"]);
    const minute = (key: string) => {
      const v = q[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= 24 * 60) {
        throw new ConfigError(`rate.quietPeriod.${key}`, "must be a minute of the day, 0 to 1439");
      }
      return v;
    };
    r.quietPeriod = { startMinute: minute("startMinute"), endMinute: minute("endMinute") };
  }
  return r;
}

function github(value: unknown): GitHubConfig {
  const gh = object(value, "github", ["owner", "repo", "label", "userLogin", "botLogin", "appId", "installationId", "privateKeyPath"]);
  return {
    owner: str(gh, "owner", "github."),
    repo: str(gh, "repo", "github."),
    label: gh.label === undefined ? "aoa" : str(gh, "label", "github."),
    userLogin: str(gh, "userLogin", "github."),
    botLogin: str(gh, "botLogin", "github."),
    appId: id(gh, "appId", "github."),
    installationId: id(gh, "installationId", "github."),
    privateKeyPath: str(gh, "privateKeyPath", "github."),
  };
}

function riskTable(value: unknown, field: string): Record<string, Risk> {
  const risk = object(value, field, Object.keys((value ?? {}) as Obj));
  for (const [tool, tier] of Object.entries(risk)) {
    if (tier !== "low" && tier !== "medium" && tier !== "high") throw new ConfigError(`${field}.${tool}`, "must be low, medium or high");
  }
  return risk as Record<string, Risk>;
}

/** Lowercase, so it is safe in an inbox id, a directory name and a branch name. */
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The default agent's name: it is the top level of the config, so no named agent may take it. */
export const DEFAULT_AGENT = "default";

function agents(value: unknown, top: AgentConfig): Record<string, NamedAgent> {
  const all = object(value, "agents", Object.keys((value ?? {}) as Obj));
  const named: Record<string, NamedAgent> = {};
  for (const [name, raw] of Object.entries(all)) {
    const field = `agents.${name}`;
    if (!AGENT_NAME.test(name)) throw new ConfigError(field, "is not a valid agent name: a lowercase letter, then up to 31 lowercase letters, digits or -");
    if (name === DEFAULT_AGENT) throw new ConfigError(field, "is reserved for the agent the top-level fields describe");
    const a = object(raw, field, ["role", "instructions", "model", "classifier", "risk"]);
    if (a.role !== undefined && a.role !== "implement" && a.role !== "review") throw new ConfigError(`${field}.role`, "must be implement or review");
    const agent: NamedAgent = {
      role: (a.role as Role | undefined) ?? "implement",
      model: a.model === undefined ? top.model : modelRef(a.model, `${field}.model`),
    };
    if (a.instructions !== undefined) agent.instructions = str(a, "instructions", `${field}.`);
    const classifier = a.classifier === undefined ? top.classifier : modelRef(a.classifier, `${field}.classifier`);
    if (classifier) agent.classifier = classifier;
    const risk = a.risk === undefined ? top.risk : riskTable(a.risk, `${field}.risk`);
    if (risk) agent.risk = risk;
    named[name] = agent;
  }
  return named;
}

/** Checks a loaded config; the error names the first bad field. */
export function validateConfig(raw: unknown): AgentConfig {
  const c = object(raw, "config", ["dataDir", "repo", "model", "classifier", "shadowJudge", "github", "risk", "rate", "agents"]);
  const repo = object(c.repo, "repo", ["path", "base"]);
  const config: AgentConfig = {
    dataDir: str(c, "dataDir", ""),
    repo: { path: str(repo, "path", "repo."), base: str(repo, "base", "repo.") },
    model: modelRef(c.model, "model"),
  };
  if (c.github !== undefined) config.github = github(c.github);
  if (c.classifier !== undefined) config.classifier = modelRef(c.classifier, "classifier");
  if (c.shadowJudge !== undefined) {
    const judge = modelRef(c.shadowJudge, "shadowJudge");
    if (judge.provider !== "typesafe") throw new ConfigError("shadowJudge.provider", "must be typesafe");
    config.shadowJudge = judge;
  }
  if (c.risk !== undefined) config.risk = riskTable(c.risk, "risk");
  if (c.rate !== undefined) config.rate = rate(c.rate);
  if (c.agents !== undefined) {
    // An issue or a pull request has no way to name the agent it is for.
    if (config.github) throw new ConfigError("agents", "cannot be used with github: GitHub mode runs one agent");
    config.agents = agents(c.agents, config);
  }
  return config;
}

/**
 * What `serve` needs beyond a valid config. `bash` and `git_push` are `medium`, and a `medium` call with no
 * classifier waits for the user, so without one the agent cannot even run the project's checks unattended.
 */
export function validateForServe(c: AgentConfig): void {
  if (!c.classifier) {
    throw new ConfigError(
      "classifier",
      "is required for serve: without it every bash and git_push call waits for your approval, so the agent cannot run checks or commit on its own",
    );
  }
}

export type Paths = {
  inboxId: string;
  dataDir: string;
  db: string;
  memory: string;
  sessions: string;
  piAgent: string;
  worktrees: string;
  repo: string;
  /** The GitHub App key; null in local mode. */
  privateKey: string | null;
};

const expand = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path);

/**
 * Everything below `dataDir` is derived, never configured (one layout per inbox). A named agent's inbox is the
 * repo's with `@<agent>`, so its memory and worktrees sit beside the default agent's rather than inside them.
 */
export function derivePaths(c: AgentConfig, home = homedir(), agent?: string): Paths {
  const dataDir = expand(c.dataDir, home);
  const repo = expand(c.repo.path, home);
  const [owner, repoName] = c.github ? [c.github.owner, c.github.repo] : ["local", basename(repo)];
  const name = agent === undefined ? repoName : `${repoName}@${agent}`;
  return {
    inboxId: `${owner}/${name}`,
    dataDir,
    db: join(dataDir, "aoa.db"),
    memory: join(dataDir, "memory", owner, name),
    sessions: join(dataDir, "sessions"),
    piAgent: join(dataDir, "pi"),
    worktrees: join(dataDir, "worktrees", owner, name),
    repo,
    privateKey: c.github ? expand(c.github.privateKeyPath, home) : null,
  };
}

/**
 * The config file a command uses: the one named, else `aoa.config.ts` in the current directory, else the one in
 * `~/.aoa`, so the command works from any directory.
 */
export function findConfig(explicit: string | undefined, cwd: string, home = homedir()): string {
  if (explicit !== undefined) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  const candidates = [join(cwd, "aoa.config.ts"), join(home, ".aoa", "aoa.config.ts")];
  const found = candidates.find((file) => existsSync(file));
  if (found === undefined) throw new Error(`No config found. Looked for ${candidates.join(" and ")}; or pass --config <path>.`);
  return found;
}

/** Imports the config file and validates its default export. */
export async function loadConfig(path: string, cwd: string): Promise<AgentConfig> {
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new Error(`Could not load the config ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateConfig(mod.default);
}
