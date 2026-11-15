import { mkdirSync } from "node:fs";
import { type FetchFn, type GitHubChannel, type GitRunner, githubChannel, githubTools, runGitWithBun } from "@aoa/channel-github";
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
  type RunOutcome,
} from "@aoa/kernel";
import { codingTools, piClassifier, piRuntime } from "@aoa/runtime-pi";
import { type SqliteStore, sqliteStore } from "@aoa/store-sqlite";
import type { Provider } from "@earendil-works/pi-ai";
import { type AgentConfig, type ModelRef, type Paths, derivePaths } from "./config.ts";
import { agentPolicy } from "./policy.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { pullOf } from "./status.ts";
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
};

export type Agent = {
  config: AgentConfig;
  paths: Paths;
  inboxId: string;
  store: SqliteStore;
  clock: Clock;
  log: (line: string) => void;
  channel: GitHubChannel;
  worker: Worker;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  poller: ChannelPoller;
  worktrees: Worktrees;
  /** Stores the state of every pull request of a session that is not closed; a merged or closed one ends its session. */
  checkPulls(): Promise<void>;
  /** Stores the state of every session's pull request, closed sessions included, and changes nothing else. */
  refreshPulls(): Promise<void>;
  close(): void;
};

const defaultLog = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
  const github = {
    ...config.github,
    privateKeyPath: paths.privateKey,
    now: () => clock.now(),
    ...(seams.fetch ? { fetch: seams.fetch } : {}),
  };
  const channel = githubChannel(github);
  const trees = worktrees({ repo: paths.repo, base: config.repo.base, root: paths.worktrees, runGit });
  // A missing key is reported by name when a model call needs it, so `status` and `answer` work without one.
  const keys = new Map([config.model, config.classifier].filter((m) => m !== undefined).map((m) => [m.apiKeyEnv, env[m.apiKeyEnv]]));
  // pi holds the keys in memory from here on; the agent's bash and git inherit this environment, so they go.
  for (const name of keys.keys()) delete env[name];
  const keyOf = (m: ModelRef) => keys.get(m.apiKeyEnv);

  const runtime = piRuntime({
    provider: config.model.provider,
    modelId: config.model.modelId,
    apiKey: keyOf(config.model),
    agentDir: paths.piAgent,
    sessionsDir: paths.sessions,
    cwd: paths.repo,
    systemPrompt: SYSTEM_PROMPT,
    providers: seams.providers,
  });
  const classify = config.classifier
    ? piClassifier({
        provider: config.classifier.provider,
        modelId: config.classifier.modelId,
        apiKey: keyOf(config.classifier),
        providers: seams.providers,
      })
    : undefined;

  const deps = { store, clock, inboxId };
  const tools = [
    ...codingTools(),
    ...timerTools(deps),
    ...outboxTools(deps),
    ...memoryTools(memory),
    ...askUserTools(),
    ...followTools({ store, inboxId }),
    ...githubTools({ ...github, runGit }),
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
    policy: agentPolicy({ risk: config.risk, classify }),
    debounceMs: 2000,
    prepareSession: (session) => trees.prepare(session),
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
      const pr = store.tx((t) => pullOf(t, s.id));
      if (!pr) continue;
      let state: "open" | "merged" | "closed";
      try {
        state = await channel.pullState(pr.number);
      } catch (err) {
        log(`checking pull request #${pr.number} of session ${s.id} failed: ${errorText(err)}`);
        continue;
      }
      store.pulls.set(s.id, { number: pr.number, state, checkedAt: clock.now() });
      if (!closeFinished || state === "open") continue;
      // Closing would pull the worktree out from under a run in flight; a later check gets it.
      if (inRun(s.id)) continue;
      closeSession(store, s.id);
      if (s.workdir !== null) {
        try {
          await trees.remove(s.workdir);
          store.tx((t) => t.setSessionWorkdir(s.id, null));
        } catch (err) {
          log(`removing the worktree of session ${s.id} failed: ${errorText(err)}`);
        }
      }
      log(`session ${s.id} closed: pull request #${pr.number} was ${state}`);
    }
  }

  return {
    config,
    paths,
    inboxId,
    store,
    clock,
    log,
    channel,
    worker,
    scheduler,
    dispatcher,
    poller,
    worktrees: trees,
    checkPulls: () => lookUp(true),
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
