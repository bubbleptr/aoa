import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type FetchFn, type GitRunner, githubChannel, githubTools, runGitWithBun } from "@aoa/channel-github";
import { type Notifier, defaultNotifier, localChannel } from "@aoa/channel-local";
import {
  ChannelPoller,
  Dispatcher,
  Scheduler,
  Worker,
  askUserTools,
  closeSession,
  dirMemory,
  followTools,
  memoryTools,
  outboxTools,
  systemClock,
  timerTools,
  type Channel,
  type Clock,
  type Rule,
  type RunOutcome,
  type ToolDef,
} from "@aoa/kernel";
import { codingTools, piClassifier, piRuntime } from "@aoa/runtime-pi";
import { type SqliteStore, sqliteStore } from "@aoa/store-sqlite";
import type { Provider } from "@earendil-works/pi-ai";
import { type AgentConfig, type ModelRef, type Paths, derivePaths } from "./config.ts";
import { agentPolicy, deferPush } from "./policy.ts";
import { GITHUB_SYSTEM_PROMPT, LOCAL_SYSTEM_PROMPT } from "./prompt.ts";
import { jevJudge, withShadowJudge } from "./shadow.ts";
import { NUDGE_INTERVAL_MS, PULL_CHECK_INTERVAL_MS } from "./serve.ts";
import { type ModeColumns, branchColumns, pullColumns, pullOf } from "./status.ts";
import { type Worktrees, worktrees } from "./worktree.ts";

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
  /** Whether serve polls the channel for events. */
  polls: boolean;
  /** How often serve looks for finished sessions. */
  finishCheckMs: number;
  statusColumns: ModeColumns;
};

export type Agent = {
  config: AgentConfig;
  paths: Paths;
  inboxId: string;
  store: SqliteStore;
  clock: Clock;
  log: (line: string) => void;
  mode: Front["mode"];
  channel: Channel;
  openThread: Front["openThread"];
  /** What serve runs besides the loops. */
  schedule: { polls: boolean; finishCheckMs: number };
  statusColumns: ModeColumns;
  worker: Worker;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  poller: ChannelPoller;
  worktrees: Worktrees;
  /**
   * Closes every open session that has finished, and removes its worktree (never its branch). GitHub mode: its
   * pull request was merged or closed, which it stores. Local mode: the user declared how it ended with `aoa close`.
   */
  closeFinished(): Promise<void>;
  /** GitHub mode: stores the state of every session's pull request, closed sessions included, and changes nothing else. */
  refreshPulls(): Promise<void>;
  close(): void;
};

const defaultLog = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const TITLE_LIMIT = 80;

type FrontDeps = {
  paths: Paths;
  store: SqliteStore;
  clock: Clock;
  runGit: GitRunner;
  seams: Seams;
  log: (line: string) => void;
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
    tools: [...followTools({ store: d.store, inboxId: d.paths.inboxId }), ...githubTools({ ...github, runGit: d.runGit })],
    systemPrompt: GITHUB_SYSTEM_PROMPT,
    rules: [],
    fromOrigin: true,
    openThread: (text) => channel.openThread(text.trim().split("\n")[0]!.trim().slice(0, TITLE_LIMIT), text),
    async finished(sessionId) {
      const pr = d.store.tx((t) => pullOf(t, sessionId));
      if (!pr) return null;
      let state: "open" | "merged" | "closed";
      try {
        state = await channel.pullState(pr.number);
      } catch (err) {
        d.log(`checking pull request #${pr.number} of session ${sessionId} failed: ${errorText(err)}`);
        return null;
      }
      d.store.pulls.set(sessionId, { number: pr.number, state, checkedAt: d.clock.now() });
      return state === "open" ? null : `pull request #${pr.number} was ${state}`;
    },
    closed: () => {},
    polls: true,
    finishCheckMs: PULL_CHECK_INTERVAL_MS,
    statusColumns: pullColumns,
  };
}

function localFront(d: FrontDeps): Front {
  const channel = localChannel({ file: join(d.paths.dataDir, "messages.md"), notify: d.seams.notify ?? defaultNotifier(), log: d.log });
  return {
    mode: "local",
    channel,
    tools: [],
    systemPrompt: LOCAL_SYSTEM_PROMPT,
    rules: [deferPush],
    fromOrigin: false,
    openThread: async () => channel.openThread(),
    async finished(sessionId) {
      const declared = d.store.results.get(sessionId);
      return declared && !declared.applied ? `declared ${declared.result}` : null;
    },
    closed: (sessionId) => d.store.results.markApplied(sessionId),
    polls: false,
    // Reads only the store, so it can run as often as serve looks for other processes' writes.
    finishCheckMs: NUDGE_INTERVAL_MS,
    statusColumns: branchColumns,
  };
}

/** The one assembly of the agent: `serve`, the other commands and the end-to-end test all go through it. */
export function assemble(config: AgentConfig, seams: Seams = {}): Agent {
  const paths = derivePaths(config);
  const clock = seams.clock ?? systemClock;
  const env = seams.env ?? process.env;
  const log = seams.log ?? defaultLog;
  const runGit = seams.runGit ?? runGitWithBun;
  const { inboxId } = paths;

  mkdirSync(paths.dataDir, { recursive: true });
  const store = sqliteStore(paths.db);
  const memory = dirMemory(paths.memory);
  const frontDeps = { paths, store, clock, runGit, seams, log };
  const front = config.github ? githubFront(config.github, frontDeps) : localFront(frontDeps);
  const { channel } = front;
  const trees = worktrees({ repo: paths.repo, base: config.repo.base, root: paths.worktrees, runGit, fromOrigin: front.fromOrigin });
  // A missing key is reported by name when a model call needs it, so `status` and `answer` work without one.
  /** Worktree removals in progress, by session; preparing that session's worktree waits for its removal. */
  const removals = new Map<string, Promise<void>>();
  const keys = new Map(
    [config.model, config.classifier, config.shadowJudge]
      .filter((m): m is ModelRef => m !== undefined)
      .map((m) => [m.apiKeyEnv, env[m.apiKeyEnv]]),
  );
  // The model clients hold the keys in memory from here on; the agent's bash and git inherit this environment, so they go.
  for (const name of keys.keys()) delete env[name];
  const keyOf = (m: ModelRef) => keys.get(m.apiKeyEnv);

  const runtime = piRuntime({
    provider: config.model.provider,
    modelId: config.model.modelId,
    apiKey: keyOf(config.model),
    agentDir: paths.piAgent,
    sessionsDir: paths.sessions,
    cwd: paths.repo,
    systemPrompt: front.systemPrompt,
    providers: seams.providers,
  });
  const classify = config.classifier
    ? withShadowJudge(
        piClassifier({
          provider: config.classifier.provider,
          modelId: config.classifier.modelId,
          apiKey: keyOf(config.classifier),
          providers: seams.providers,
        }),
        config.shadowJudge
          ? jevJudge({
              modelId: config.shadowJudge.modelId,
              apiKey: keyOf(config.shadowJudge),
              fetch: seams.fetch ?? fetch,
              clock,
              log,
              record: (j) => store.tx((t) => t.recordJudgment(j)),
            })
          : undefined,
      )
    : undefined;

  const deps = { store, clock, inboxId };
  const tools = [
    ...codingTools(),
    ...timerTools(deps),
    ...outboxTools(deps),
    ...memoryTools(memory),
    ...askUserTools(),
    ...front.tools,
  ];

  const logged: Channel = {
    poll: (cursor) => channel.poll(cursor),
    async deliver(m) {
      try {
        await channel.deliver(m);
      } catch (err) {
        log(`delivery of ${m.kind} ${m.id} to ${m.thread} failed: ${errorText(err)}`);
        throw err;
      }
      log(`delivered ${m.kind} ${m.id} to ${m.thread}`);
    },
  };
  const dispatcher = new Dispatcher({ ...deps, channel: logged, ...(config.rate ? { policy: config.rate } : {}) });
  const worker: Worker = new Worker({
    ...deps,
    runtime,
    tools,
    memory,
    policy: agentPolicy({ risk: config.risk, classify, rules: front.rules }),
    debounceMs: 2000,
    prepareSession: async (session) => {
      await removals.get(session.id);
      return trees.prepare(session);
    },
    onRunStart: (r) => log(`run ${r.runId} started in session ${r.sessionId} with ${r.events} event(s)`),
    onRunEnd: (r) => {
      log(runEndLine(r));
      dispatcher.wake();
    },
  });
  const scheduler = new Scheduler({ ...deps, onFire: () => worker.wake() });
  const poller = new ChannelPoller({ ...deps, channel: logged, onEvents: () => worker.wake() });

  const inRun = (sessionId: string) =>
    store.tx((t) => t.listEvents(inboxId)).some((e) => e.status === "in_run" && e.resume === sessionId);

  async function lookUp(closeFinished: boolean): Promise<void> {
    const sessions = store.tx((t) => t.listSessions(inboxId));
    for (const s of sessions) {
      if (closeFinished && s.status === "closed") continue;
      const reason = await front.finished(s.id);
      if (!closeFinished || reason === null) continue;
      // Closing would pull the worktree out from under a run in flight; a later check gets it.
      if (inRun(s.id)) continue;
      // No await from here until the removal is registered: an event that reopens the session finds no
      // workdir, so the worker prepares one, and preparing waits for the removal to finish.
      const workdir = store.tx((t) => {
        const current = t.getSession(s.id)!.workdir;
        t.setSessionWorkdir(s.id, null);
        return current;
      });
      closeSession(store, s.id);
      front.closed(s.id);
      if (workdir !== null) {
        const removal = trees
          .remove(workdir)
          .catch((err) => log(`removing the worktree of session ${s.id} failed: ${errorText(err)}`))
          .finally(() => removals.delete(s.id));
        removals.set(s.id, removal);
        await removal;
      }
      log(`session ${s.id} closed: ${reason}`);
    }
  }

  return {
    config,
    paths,
    inboxId,
    store,
    clock,
    log,
    mode: front.mode,
    channel,
    openThread: front.openThread,
    schedule: { polls: front.polls, finishCheckMs: front.finishCheckMs },
    statusColumns: front.statusColumns,
    worker,
    scheduler,
    dispatcher,
    poller,
    worktrees: trees,
    closeFinished: () => lookUp(true),
    refreshPulls: () => lookUp(false),
    close: () => store.close(),
  };
}

function runEndLine(r: RunOutcome): string {
  if (r.error !== null) return `run ${r.runId} failed: ${r.error}`;
  switch (r.end?.kind) {
    case "sent":
      return `run ${r.runId} ended: sent ${r.end.msgs.length} message(s)`;
    case "deferred":
      return `run ${r.runId} ended: deferred call ${r.end.callId}`;
    default:
      return `run ${r.runId} ended: silent`;
  }
}
