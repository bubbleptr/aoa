import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FetchFn, type GitRunner, githubChannel, githubTools, runGitWithBun } from "@aoa-dev/channel-github";
import { type Notifier, defaultNotifier, localChannel } from "@aoa-dev/channel-local";
import { piCompletion, piRuntime } from "@aoa-dev/sdk/pi";
import { codingTools } from "@aoa-dev/sdk/tools/coding";
import {
  DEAD_NOTICE_PREFIX,
  createHost,
  dirMemory,
  followTool,
  sendToTool,
  systemClock,
  type Agent as HostAgent,
  type Channel,
  type Clock,
  type Host,
  type Reader,
  type Rule,
  type ToolDef,
} from "@aoa-dev/sdk";
import { type SqliteStore, sqliteStore } from "@aoa-dev/store-sqlite";
import type { Provider } from "@earendil-works/pi-ai";
import {
  type AgentConfig,
  DEFAULT_AGENT,
  type ModelRef,
  type NamedAgent,
  type Paths,
  type Role,
  type Runtime,
  derivePaths,
} from "./config.ts";
import { agentPolicy, deferPush, reviewReadOnly } from "./policy.ts";
import { GITHUB_SYSTEM_PROMPT, LOCAL_SYSTEM_PROMPT, handOffPrompt, reviewPrompt } from "./prompt.ts";
import { type Records, records } from "./records.ts";
import { reviewer } from "./reviewer.ts";
import { jevJudge, withShadowJudge } from "./shadow.ts";
import { LOCAL_FINISH_CHECK_MS, PULL_CHECK_INTERVAL_MS } from "./serve.ts";
import { type ModeColumns, branchColumns, pullColumns, pullOf } from "./status.ts";
import { type Worktrees, sessionBranch, worktrees } from "./worktree.ts";

/** What the outside world is, for this process. Tests swap these; `serve` uses the defaults. */
export type Seams = {
  fetch?: FetchFn;
  runGit?: GitRunner;
  /** Extra pi-ai providers, e.g. a scripted model. */
  providers?: Provider[];
  clock?: Clock;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** Local mode's desktop notification; by default the platform's. */
  notify?: Notifier;
};

/**
 * Everything that differs between GitHub mode and local mode, decided once in `assemble`. The rest of the
 * agent, and the commands, serve and status, only ever see this.
 */
type Front = {
  mode: "github" | "local";
  channel: Channel;
  tools: ToolDef[];
  systemPrompt: string;
  /** Policy rules on top of the kernel's. */
  rules: Rule[];
  /** Whether a new worktree starts from a freshly fetched `origin/<base>` or from the local `<base>`. */
  fromOrigin: boolean;
  /** Opens a thread for a task the user sends from this machine. */
  openThread(text: string): Promise<string>;
  /** Why the session has finished, or null if it has not. Records what it looked up. */
  finished(sessionId: string): Promise<string | null>;
  /** Called right after the session was closed because it finished. */
  closed(sessionId: string): void;
  /** How often serve looks for finished sessions. */
  finishCheckMs: number;
  statusColumns: ModeColumns;
};

export type Agent = {
  /** `default` for the agent the config's top level describes. */
  name: string;
  role: Role;
  runtime: Runtime;
  /** Who decides what the agent's own tools may do (design §12). */
  permissions: "kernel" | "harness";
  /** Every agent of the config, the default one first; they share one store, clock and process. */
  agents: Agent[];
  config: AgentConfig;
  paths: Paths;
  inboxId: string;
  store: SqliteStore;
  /** The app's own tables beside the kernel's. */
  records: Records;
  clock: Clock;
  log: (line: string) => void;
  mode: Front["mode"];
  channel: Channel;
  openThread: Front["openThread"];
  /** What serve runs besides the loops. */
  schedule: { finishCheckMs: number };
  statusColumns: ModeColumns;
  /** The agent as the host knows it: appends, answers and reads go through it. */
  hosted: HostAgent;
  /** One pass of each of the agent's loops. */
  step: HostAgent["step"];
  /** The host that runs every agent's loops. */
  host: Host;
  worktrees: Worktrees;
  /**
   * Closes every open session that has finished, and removes its worktree (never its branch). GitHub mode: its
   * pull request was merged or closed, which it stores. Local mode: the user declared how it ended with `aoa close`.
   */
  closeFinished(): Promise<void>;
  /** GitHub mode: stores the state of every session's pull request, closed sessions included, and changes nothing else. */
  refreshPulls(): Promise<void>;
  /** Closes the store all the agents share. */
  close(): void;
  page: PageLink;
};

/**
 * The observation page this process serves, shared by every agent: `startWeb` sets it, the local channel reads it to
 * leave approval notifications to a page that shows them itself.
 */
export class PageLink {
  url: string | null = null;
  /** Open pages that have notifications on. */
  notifying = 0;
  state(): { url: string; notifying: boolean } | null {
    return this.url === null ? null : { url: this.url, notifying: this.notifying > 0 };
  }
}

const defaultLog = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const TITLE_LIMIT = 80;

type FrontDeps = {
  /** Named in the messages file and notifications when there are several agents. */
  label: string | undefined;
  /** The branch of a session, null for an agent whose sessions work detached. */
  branchOf: ((sessionId: string) => string) | null;
  paths: Paths;
  host: Host;
  read: () => Reader;
  records: Records;
  clock: Clock;
  runGit: GitRunner;
  seams: Seams;
  log: (line: string) => void;
  page: PageLink;
};

function githubFront(gh: NonNullable<AgentConfig["github"]>, d: FrontDeps): Front {
  const github = {
    ...gh,
    privateKeyPath: d.paths.privateKey!,
    now: () => d.clock.now(),
    ...(d.seams.fetch ? { fetch: d.seams.fetch } : {}),
  };
  const channel = githubChannel(github);
  return {
    mode: "github",
    channel,
    tools: [followTool(d.host), ...githubTools({ ...github, runGit: d.runGit })],
    systemPrompt: GITHUB_SYSTEM_PROMPT,
    rules: [],
    fromOrigin: true,
    openThread: (text) => channel.openThread(text.trim().split("\n")[0]!.trim().slice(0, TITLE_LIMIT), text),
    async finished(sessionId) {
      const pr = pullOf(d.read(), sessionId);
      if (!pr) return null;
      let state: "open" | "merged" | "closed";
      try {
        state = await channel.pullState(pr.number);
      } catch (err) {
        d.log(`checking pull request #${pr.number} of session ${sessionId} failed: ${errorText(err)}`);
        return null;
      }
      d.records.pulls.set(sessionId, { number: pr.number, state, checkedAt: d.clock.now() });
      return state === "open" ? null : `pull request #${pr.number} was ${state}`;
    },
    closed: () => {},
    finishCheckMs: PULL_CHECK_INTERVAL_MS,
    statusColumns: pullColumns,
  };
}

function localFront(d: FrontDeps): Front {
  const channel = localChannel({
    file: join(d.paths.dataDir, "messages.md"),
    notify: d.seams.notify ?? defaultNotifier(),
    log: d.log,
    page: () => d.page.state(),
    ...(d.label === undefined ? {} : { agent: d.label }),
  });
  return {
    mode: "local",
    channel,
    tools: [],
    systemPrompt: LOCAL_SYSTEM_PROMPT,
    rules: [deferPush],
    fromOrigin: false,
    openThread: async () => channel.openThread(),
    async finished(sessionId) {
      const declared = d.records.results.get(sessionId);
      return declared && !declared.applied ? `declared ${declared.result}` : null;
    },
    closed: (sessionId) => d.records.results.markApplied(sessionId),
    finishCheckMs: LOCAL_FINISH_CHECK_MS,
    statusColumns: branchColumns(d.branchOf),
  };
}

type Spec = NamedAgent & { name: string };

type Shared = {
  config: AgentConfig;
  seams: Seams;
  store: SqliteStore;
  records: Records;
  clock: Clock;
  log: (line: string) => void;
  runGit: GitRunner;
  keyOf: (m: { apiKeyEnv: string }) => string | undefined;
  roster: Spec[];
  agents: Agent[];
  page: PageLink;
  host: Host;
};

/**
 * The one assembly: `serve`, the other commands and the end-to-end test all go through it. Returns the default
 * agent; `agents` holds it and every named one, all on one store and clock.
 */
export function assemble(config: AgentConfig, seams: Seams = {}): Agent {
  const clock = seams.clock ?? systemClock;
  const env = seams.env ?? process.env;
  const roster: Spec[] = [
    { name: DEFAULT_AGENT, ...topAgent(config) },
    ...Object.entries(config.agents ?? {}).map(([name, a]) => ({ name, ...a })),
  ];
  const { dataDir, db } = derivePaths(config);
  mkdirSync(dataDir, { recursive: true });
  const store = sqliteStore(db);
  // A missing key is reported by name when a model call needs it, so `status` and `answer` work without one.
  const keys = new Map(
    [
      ...roster.flatMap((a) => [a.model, ...(a.classifier ? [a.classifier] : [])]),
      config.shadowJudge,
    ]
      .filter((m): m is ModelRef => m !== undefined)
      .map((m) => [m.apiKeyEnv, env[m.apiKeyEnv]]),
  );
  // The model clients hold the keys in memory from here on; the agents' bash and git inherit this environment, so they go.
  for (const name of keys.keys()) delete env[name];
  const shared: Shared = {
    config,
    seams,
    store,
    records: records(store),
    clock,
    log: seams.log ?? defaultLog,
    runGit: seams.runGit ?? runGitWithBun,
    keyOf: (m) => keys.get(m.apiKeyEnv),
    roster,
    agents: [],
    page: new PageLink(),
    host: createHost({ store, clock, log: seams.log ?? defaultLog }),
  };
  for (const spec of roster) shared.agents.push(assembleOne(spec, shared));
  return shared.agents[0]!;
}

function assembleOne(spec: Spec, s: Shared): Agent {
  const { config, seams, store, clock, log, runGit } = s;
  const { records: recorded } = s;
  const named = spec.name !== DEFAULT_AGENT;
  const several = s.roster.length > 1;
  const paths = derivePaths(config, undefined, named ? spec.name : undefined);
  const { inboxId } = paths;
  const review = spec.role === "review";
  const branchOf = review ? null : (id: string) => sessionBranch(named ? spec.name : null, id);
  const memory = dirMemory(paths.memory);
  let hosted!: HostAgent;
  const frontDeps = {
    label: several ? spec.name : undefined,
    branchOf,
    paths,
    host: s.host,
    read: () => hosted.read,
    records: recorded,
    clock,
    runGit,
    seams,
    log,
    page: s.page,
  };
  const front = config.github ? githubFront(config.github, frontDeps) : localFront(frontDeps);
  const { channel } = front;
  const trees = worktrees({ repo: paths.repo, base: config.repo.base, root: paths.worktrees, runGit, fromOrigin: front.fromOrigin, branchOf });

  const reviewers = s.roster.filter((a) => a.role === "review").map((a) => a.name);
  const rolePrompt = review
    ? reviewPrompt(config.repo.base)
    : reviewers.length > 0
      ? `${front.systemPrompt}\n\n${handOffPrompt(reviewers)}`
      : front.systemPrompt;
  const systemPrompt = spec.instructions === undefined ? rolePrompt : `${rolePrompt}\n\n${spec.instructions}`;
  const runtime = piRuntime({
    provider: spec.model.provider,
    modelId: spec.model.modelId,
    apiKey: s.keyOf(spec.model),
    agentDir: paths.piAgent,
    sessionsDir: paths.sessions,
    cwd: paths.repo,
    systemPrompt,
    providers: seams.providers,
  });
  // Who decides the agent's own tool calls follows from the runtime's tier.
  const permissions = runtime.kind;
  const classify = spec.classifier
    ? withShadowJudge(
        reviewer({
          role: spec.role,
          complete: piCompletion({
            provider: spec.classifier.provider,
            modelId: spec.classifier.modelId,
            apiKey: s.keyOf(spec.classifier),
            providers: seams.providers,
          }),
        }),
        config.shadowJudge
          ? jevJudge({
              modelId: config.shadowJudge.modelId,
              apiKey: s.keyOf(config.shadowJudge),
              fetch: seams.fetch ?? fetch,
              clock,
              log,
              record: (j) => recorded.judgments.record(j),
            })
          : undefined,
      )
    : undefined;

  /** The branch a review session was asked to look at: the first of its events that names one. */
  const reviewedBranch = (sessionId: string): string | undefined =>
    hosted.read
      .events({ sessionId })
      .map((e) => (e.payload as { branch?: unknown } | null)?.branch)
      .find((b): b is string => typeof b === "string");
  hosted = s.host.agent({
    name: spec.name,
    description: spec.role,
    inbox: inboxId,
    runtime,
    tools: (builtins) => {
      const all = [
        ...codingTools(),
        ...builtins,
        ...front.tools,
        ...(several ? [handOff(s)] : []),
      ];
      // A reviewer reads, runs and reports: no way to change files or to stop and ask (its verdict is the answer).
      return review ? all.filter((t) => !["edit", "write", "ask_user"].includes(t.name)) : all;
    },
    memory,
    policy: agentPolicy({ risk: spec.risk, classify, ahead: review ? [reviewReadOnly] : [], rules: front.rules }),
    channel: withStatusHint(channel),
    ...(config.rate ? { rate: config.rate } : {}),
    session: {
      prepare: (session) => (review ? trees.prepare(session, reviewedBranch(session.id)) : trees.prepare(session)),
      // The branch stays: it is the work.
      cleanup: (session, workdir) =>
        trees.remove(workdir).catch((err) => log(`removing the worktree of session ${session.id} failed: ${errorText(err)}`)),
    },
  });

  async function lookUp(closeFinished: boolean): Promise<void> {
    const sessions = hosted.read.sessions();
    for (const s of sessions) {
      if (closeFinished && s.status === "closed") continue;
      const reason = await front.finished(s.id);
      if (!closeFinished || reason === null) continue;
      // A session a run is using is left for a later check. The declaration is marked applied in step with the close,
      // so a session that a later event reopens is not closed again by it.
      if ((await hosted.closeSession(s.id, { afterClose: () => front.closed(s.id) })) === "busy") continue;
      log(`session ${s.id} closed: ${reason}`);
    }
  }

  return {
    name: spec.name,
    role: spec.role,
    runtime: spec.runtime,
    permissions,
    agents: s.agents,
    config,
    paths,
    inboxId,
    store,
    records: recorded,
    clock,
    log,
    mode: front.mode,
    channel,
    openThread: front.openThread,
    schedule: { finishCheckMs: front.finishCheckMs },
    statusColumns: front.statusColumns,
    hosted,
    step: hosted.step,
    host: s.host,
    worktrees: trees,
    closeFinished: () => lookUp(true),
    refreshPulls: () => lookUp(false),
    close: () => store.close(),
    page: s.page,
  };
}

/**
 * `send_to` between the config's agents: a review agent may be given the branch to review, which must exist, and a
 * message that is not a reply opens a thread the way a task the user sends does (an issue in GitHub mode).
 */
function handOff(s: Shared): ToolDef {
  const appAgent = (name: string) => s.agents.find((a) => a.name === name)!;
  return sendToTool(s.host, {
    params: { branch: { type: "string", description: "Only for a review agent: the branch to review." } },
    async check(target, args) {
      const { branch } = args;
      if (branch === undefined) return;
      if (typeof branch !== "string" || branch === "") throw new Error("branch must be a non-empty string");
      const to = appAgent(target.name);
      if (to.role !== "review") throw new Error(`branch is only for a review agent; ${to.name} implements.`);
      if ((await to.worktrees.commitOf(branch)) === null) throw new Error(`There is no branch ${branch} in the repository.`);
    },
    thread: (target, args) => appAgent(target.name).openThread(args.text),
  });
}

/** The SDK's dead-letter notice names no command; aoa's ends by pointing at `aoa status`. */
export function withStatusHint(channel: Channel): Channel {
  return {
    ...(channel.poll ? { poll: (cursor: string | null) => channel.poll!(cursor) } : {}),
    deliver: (m) =>
      channel.deliver(
        m.detail?.kind === "dead_letter" || m.dedupeKey.startsWith(DEAD_NOTICE_PREFIX)
          ? { ...m, body: `${m.body}\n\nRun \`aoa status\` for the details.` }
          : m,
      ),
  };
}

/** The default agent: the top-level config, which describes nothing else about it. */
function topAgent(config: AgentConfig): NamedAgent {
  return {
    role: "implement",
    runtime: "pi",
    model: config.model,
    ...(config.classifier ? { classifier: config.classifier } : {}),
    ...(config.risk ? { risk: config.risk } : {}),
  };
}
