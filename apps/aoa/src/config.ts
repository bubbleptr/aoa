import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RatePolicy, Risk } from "@aoa/sdk";
import type { PermissionPreset } from "@aoa/example-dsh";

export type ModelRef = {
  /** pi provider id, e.g. `anthropic`. */
  provider: string;
  modelId: string;
  /** The environment variable that holds the API key. The key itself never appears in the config. */
  apiKeyEnv: string;
};

export type Role = "implement" | "review";

/** Where aoa starts dsh and which of dsh's permission presets it runs; both optional. */
export type DshOptions = { command?: string; preset?: PermissionPreset };

/**
 * What runs an agent (design §12). `pi`: aoa's own loop, every tool call decided by aoa. `codex`: a Codex app-server
 * thread whose own tools Codex runs under the user's Codex configuration; Codex authenticates itself, and `model`,
 * when set, is a Codex model id. `dsh`: a DeepSeek Harness SDK process whose own tools dsh runs under its own
 * sandbox and approval settings; `model` is a dsh model name and `apiKeyEnv` names the variable its key comes from.
 */
export type RuntimeChoice =
  | { runtime: "pi"; model: ModelRef }
  | { runtime: "codex"; model?: string }
  | { runtime: "dsh"; model: string; apiKeyEnv: string; dsh?: DshOptions };

export type Runtime = RuntimeChoice["runtime"];

/** Who decides what the agent's own tools may do: aoa's kernel, or the harness the agent runs in. */
/** A named agent with everything it did not set taken from the top level. */
export type NamedAgent = {
  role: Role;
  /** Appended to the role's system prompt. */
  instructions?: string;
  classifier?: ModelRef;
  risk?: Record<string, Risk>;
} & RuntimeChoice;

/** What a config file writes for one named agent. */
export type AgentInput = {
  role?: Role;
  instructions?: string;
  runtime?: Runtime;
  model?: ModelRef | string;
  /** For a dsh agent: the variable its key comes from. */
  apiKeyEnv?: string;
  /** For a dsh agent: where dsh is and which profile it runs. */
  dsh?: DshOptions;
  classifier?: ModelRef;
  risk?: Record<string, Risk>;
};

export type AgentConfig = {
  dataDir: string;
  /** Set for a dsh agent: the variable its key comes from, and where dsh is. */
  apiKeyEnv?: string;
  dsh?: DshOptions;
  repo: { path: string; base: string };
  /** Judges `medium` calls of the agents that run on pi; without one they wait for the user. */
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
} & RuntimeChoice;

type GitHubConfig = NonNullable<AgentConfig["github"]>;

/** What a config file writes; the App ids may be numbers, and the runtime defaults to pi. */
export type AgentConfigInput = Omit<AgentConfig, "github" | "agents" | "runtime" | "model" | "apiKeyEnv" | "dsh"> & {
  runtime?: Runtime;
  model?: ModelRef | string;
  apiKeyEnv?: string;
  dsh?: DshOptions;
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

function runtimeOf(value: unknown, field: string): Runtime | undefined {
  if (value === undefined || value === "pi" || value === "codex" || value === "dsh") return value;
  throw new ConfigError(field, "must be pi, codex or dsh");
}

/** A dsh model name; the key and the provider route are configured next to it. */
function dshModel(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(field, "must be a dsh model name (a string) for a dsh agent");
  return value;
}

const PERMISSION_PRESETS: readonly PermissionPreset[] = ["read-only", "workspace-write", "danger-full-access"];

function dshOptions(value: unknown, field: string): DshOptions {
  const o = object(value, field, ["command", "preset"]);
  const options: DshOptions = {};
  if (o.command !== undefined) options.command = str(o, "command", `${field}.`);
  if (o.preset !== undefined) {
    const preset = str(o, "preset", `${field}.`);
    if (!PERMISSION_PRESETS.includes(preset as PermissionPreset)) {
      throw new ConfigError(`${field}.preset`, `must be a dsh permission preset: ${PERMISSION_PRESETS.join(", ")}`);
    }
    options.preset = preset as PermissionPreset;
  }
  return options;
}

/** A Codex model id; Codex holds its own credentials, so there is nothing else to name. */
function codexModel(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(field, "must be a Codex model id (a string) for a codex agent");
  return value;
}

/** The runtime and model an agent ends up with; `inherited` is what the top level has for a field the agent left out. */
function runtimeChoice(o: Obj, field: string, inherited: RuntimeChoice | null): RuntimeChoice {
  const p = field === "" ? "" : `${field}.`;
  const runtime = runtimeOf(o.runtime, `${p}runtime`) ?? inherited?.runtime ?? "pi";
  const same = inherited?.runtime === runtime ? inherited : null;
  if (runtime === "codex") {
    if (o.model !== undefined) return { runtime, model: codexModel(o.model, `${p}model`) };
    return same?.model === undefined ? { runtime } : { runtime, model: same.model as string };
  }
  if (runtime === "dsh") {
    const inheritedDsh = inherited?.runtime === "dsh" ? inherited : null;
    const model = o.model === undefined ? inheritedDsh?.model : dshModel(o.model, `${p}model`);
    if (model === undefined) throw new ConfigError(`${p}model`, "is required for a dsh agent: a dsh model name");
    const apiKeyEnv = o.apiKeyEnv === undefined ? inheritedDsh?.apiKeyEnv : str(o, "apiKeyEnv", p);
    if (apiKeyEnv === undefined) throw new ConfigError(`${p}apiKeyEnv`, "is required for a dsh agent: the variable its key comes from");
    const dsh = o.dsh === undefined ? inheritedDsh?.dsh : dshOptions(o.dsh, `${p}dsh`);
    return dsh === undefined ? { runtime, model, apiKeyEnv } : { runtime, model, apiKeyEnv, dsh };
  }
  if (o.model === undefined && same) return { runtime, model: same.model as ModelRef };
  if (o.model === undefined && inherited) throw new ConfigError(`${p}model`, "is required for a pi agent when the top level runs another runtime");
  return { runtime, model: modelRef(o.model, `${p}model`) };
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
    const a = object(raw, field, ["role", "instructions", "runtime", "model", "apiKeyEnv", "dsh", "classifier", "risk"]);
    if (a.role !== undefined && a.role !== "implement" && a.role !== "review") throw new ConfigError(`${field}.role`, "must be implement or review");
    const role = (a.role as Role | undefined) ?? "implement";
    const choice = runtimeChoice(a, field, top);
    // dsh decides what its own tools may do under its own settings; aoa's read-only rules cannot bind it.
    if (choice.runtime === "dsh" && role === "review") throw new ConfigError(`${field}.role`, "cannot be review on dsh: aoa's read-only rules do not apply to dsh's own tools");
    const agent: NamedAgent = { role, ...choice };
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
  const c = object(raw, "config", ["dataDir", "repo", "runtime", "model", "apiKeyEnv", "dsh", "classifier", "shadowJudge", "github", "risk", "rate", "agents"]);
  const repo = object(c.repo, "repo", ["path", "base"]);
  const config: AgentConfig = {
    dataDir: str(c, "dataDir", ""),
    repo: { path: str(repo, "path", "repo."), base: str(repo, "base", "repo.") },
    ...runtimeChoice(c, "", null),
  };
  if (c.github !== undefined) {
    // GitHub mode's push and pull request tools are aoa's; a harness agent would push with its own, unasked.
    if (config.runtime !== "pi") throw new ConfigError("runtime", `cannot be ${config.runtime} with github: GitHub mode runs on pi`);
    config.github = github(c.github);
  }
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
 * classifier waits for the user, so without one a pi agent cannot even run the project's checks unattended. A codex
 * agent runs commands with Codex's own tools, and every aoa tool it is offered is `low`, so it needs none.
 */
export function validateForServe(c: AgentConfig): void {
  const missing = [
    ...(c.runtime === "pi" && !c.classifier ? ["classifier"] : []),
    ...Object.entries(c.agents ?? {})
      .filter(([, a]) => a.runtime === "pi" && !a.classifier)
      .map(([name]) => `agents.${name}.classifier`),
  ];
  if (missing.length > 0) {
    throw new ConfigError(
      missing[0]!,
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
