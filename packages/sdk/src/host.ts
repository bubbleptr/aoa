import {
  ChannelPoller,
  Dispatcher,
  Scheduler,
  Worker,
  askUserTools,
  closeSession,
  memoryTools,
  outboxTools,
  systemClock,
  timerTools,
  type AgentRuntime,
  type Channel,
  type Clock,
  type DispatchResult,
  type DrainResult,
  type InboxId,
  type Memory,
  type PassResult,
  type PolicyConfig,
  type RatePolicy,
  type RunOutcome,
  type Session,
  type SessionId,
  type Store,
  type ToolDef,
} from "@aoa/kernel";

export type HostOptions = {
  store: Store;
  clock?: Clock;
  log?: (line: string) => void;
};

/** One agent: an inbox and what serves it (design §15). */
export type AgentSpec = {
  /** How the host names the agent in its log, and later what other agents call it. */
  name: string;
  inbox: InboxId;
  runtime: AgentRuntime;
  /** Who decides the agent's own tool calls. Interim: the runtime's type says it from step 3 of design §15. */
  permissions?: "kernel" | "harness";
  /**
   * The agent's tools. A list goes after the kernel's built-in ones (timers, notify, memory, ask_user). A function
   * gets the built-in ones and returns the whole list, in order, so it can place or leave out any of them.
   */
  tools?: ToolDef[] | ((builtins: ToolDef[]) => ToolDef[]);
  memory?: Memory;
  policy?: PolicyConfig;
  channel?: Channel;
  /** How often the host polls the channel while it runs; without it the channel is never polled. */
  pollMs?: number;
  /** The outbox's pace towards the channel. */
  rate?: RatePolicy;
  /** How old a group's newest event must be before it runs (D-EVT-3). Default 2000. */
  debounceMs?: number;
  session?: {
    /**
     * Gives a session without a working directory its directory before its run. Called again for the same
     * session after a crash, so it must return the same directory when it already exists.
     */
    prepare?(session: Session): Promise<{ workdir: string }>;
    /**
     * Removes a closed session's working directory. The session's next `prepare`, if an event reopens it, waits
     * for this to end. An error is logged, not thrown.
     */
    cleanup?(session: Session, workdir: string): Promise<void>;
  };
};

export interface Agent {
  readonly name: string;
  readonly inbox: InboxId;
  /**
   * Closes a session: cancels its timers, drops a call it waits on, clears its working directory, then calls
   * `afterClose` with nothing awaited in between and runs `session.cleanup`. A session a run is using right now is
   * left alone ("busy"): closing it would pull the directory out from under the run, and waiting for the run would
   * deadlock a caller inside it. Try again later.
   */
  closeSession(id: SessionId, o?: { afterClose?: () => void }): Promise<"closed" | "busy">;
  /** Tells the worker and the dispatcher to look again now. Interim: appends through the agent wake them from step 4. */
  wake(): void;
  /** One pass of each loop, for tests and for hosts that do not run the loops. */
  readonly step: {
    worker(): Promise<DrainResult>;
    scheduler(): PassResult;
    dispatcher(): Promise<DispatchResult>;
    poller(): Promise<{ accepted: number }>;
  };
}

export interface Host {
  /** Adds an agent; agents added after `start()` are not served. */
  agent(spec: AgentSpec): Agent;
  readonly agents: readonly Agent[];
  /** Runs every agent's worker, scheduler and dispatcher, and polls the channels that have `pollMs` (once right away). */
  start(): void;
  /** Stops the loops and waits for what is in flight. */
  stop(): Promise<void>;
  /** Settles once the host has stopped: after `stop()`, or after a loop died and the host stopped the rest. */
  readonly stopped: Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 2000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Loops = {
  agent: Agent;
  worker: Worker;
  scheduler: Scheduler;
  dispatcher: Dispatcher | null;
  poller: ChannelPoller | null;
  pollMs: number | undefined;
};

export function createHost(o: HostOptions): Host {
  const store = o.store;
  const clock = o.clock ?? systemClock;
  const log = o.log ?? ((line: string) => console.error(`${new Date().toISOString()} ${line}`));
  const all: Loops[] = [];
  /** Cleanups in progress, by session; preparing that session waits for its cleanup. */
  const cleanups = new Map<SessionId, Promise<void>>();

  let settle = () => {};
  const stopped = new Promise<void>((resolve) => (settle = resolve));
  let running: { stop(): Promise<void> } | null = null;

  function agent(spec: AgentSpec): Agent {
    const deps = { store, clock, inboxId: spec.inbox };
    const builtins = [...timerTools(deps), ...outboxTools(deps), ...(spec.memory ? memoryTools(spec.memory) : []), ...askUserTools()];
    const tools = typeof spec.tools === "function" ? spec.tools(builtins) : [...builtins, ...(spec.tools ?? [])];
    // Named in run lines only when there is someone to tell it from.
    const runLine = (line: string) => log(all.length > 1 ? `${spec.name}: ${line}` : line);

    const channel: Channel | null = spec.channel
      ? {
          poll: (cursor) => spec.channel!.poll(cursor),
          async deliver(m) {
            try {
              await spec.channel!.deliver(m);
            } catch (err) {
              log(`delivery of ${m.kind} ${m.id} to ${m.thread} failed: ${errorText(err)}`);
              throw err;
            }
            log(`delivered ${m.kind} ${m.id} to ${m.thread}`);
          },
        }
      : null;
    const dispatcher = channel ? new Dispatcher({ ...deps, channel, ...(spec.rate ? { policy: spec.rate } : {}) }) : null;
    const worker: Worker = new Worker({
      ...deps,
      runtime: spec.runtime,
      tools,
      ...(spec.memory ? { memory: spec.memory } : {}),
      ...(spec.policy ? { policy: spec.policy } : {}),
      ...(spec.permissions ? { permissions: spec.permissions } : {}),
      debounceMs: spec.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      ...(spec.session?.prepare
        ? {
            prepareSession: async (s: Session) => {
              await cleanups.get(s.id);
              return spec.session!.prepare!(s);
            },
          }
        : {}),
      onRunStart: (r) => runLine(`run ${r.runId} started in session ${r.sessionId} with ${r.events} event(s)`),
      onRunEnd: (r) => {
        runLine(runEndLine(r));
        dispatcher?.wake();
      },
    });
    const scheduler = new Scheduler({ ...deps, onFire: () => worker.wake() });
    const poller = channel ? new ChannelPoller({ ...deps, channel, onEvents: () => worker.wake() }) : null;

    const inRun = (id: SessionId) => store.tx((t) => t.listEvents(spec.inbox)).some((e) => e.status === "in_run" && e.resume === id);

    async function close(id: SessionId, o: { afterClose?: () => void } = {}): Promise<"closed" | "busy"> {
      if (inRun(id)) return "busy";
      // Nothing awaited until the cleanup is registered: an event that reopens the session finds no working
      // directory, so the worker prepares one, and preparing waits for the cleanup.
      const session = store.tx((t) => {
        const current = t.getSession(id)!;
        t.setSessionWorkdir(id, null);
        return current;
      });
      closeSession(store, id);
      o.afterClose?.();
      const cleanup = spec.session?.cleanup;
      if (session.workdir !== null && cleanup) {
        const running = cleanup(session, session.workdir)
          .catch((err) => log(`cleaning up session ${id} failed: ${errorText(err)}`))
          .finally(() => cleanups.delete(id));
        cleanups.set(id, running);
        await running;
      }
      return "closed";
    }

    const handle: Agent = {
      name: spec.name,
      inbox: spec.inbox,
      closeSession: close,
      wake: () => {
        worker.wake();
        dispatcher?.wake();
      },
      step: {
        worker: () => worker.drain(),
        scheduler: () => scheduler.pass(),
        dispatcher: async () => (dispatcher ? dispatcher.pass() : { delivered: 0, nextCheckAt: null }),
        poller: async () => (poller ? poller.pass() : { accepted: 0 }),
      },
    };
    all.push({ agent: handle, worker, scheduler, dispatcher, poller, pollMs: spec.pollMs });
    return handle;
  }

  function start(): void {
    if (running) return;
    const several = all.length > 1;
    const loops = all.flatMap((a) => {
      const of = (name: string) => (several ? `${name} of ${a.agent.name}` : name);
      return [
        [of("worker"), a.worker],
        [of("scheduler"), a.scheduler],
        ...(a.dispatcher ? [[of("dispatcher"), a.dispatcher] as const] : []),
      ] as const;
    });
    const repeating = all.flatMap((a) =>
      a.poller && a.pollMs !== undefined ? [every(clock, a.pollMs, () => a.poller!.pass(), (err) => log(`polling the channel failed: ${errorText(err)}`))] : [],
    );
    let stopping: Promise<void> | null = null;
    const stop = () =>
      (stopping ??= (async () => {
        for (const [, loop] of loops) loop.stop();
        await Promise.all([...repeating.map((r) => r.stop()), ...serving]);
        settle();
      })());
    const serving = loops.map(([name, loop]) =>
      loop.serve().catch((err) => {
        log(`the ${name} stopped: ${errorText(err)}`);
        void stop();
      }),
    );
    running = { stop };
  }

  return {
    agent,
    get agents() {
      return all.map((a) => a.agent);
    },
    start,
    async stop() {
      if (!running) {
        settle();
        return;
      }
      await running.stop();
    },
    stopped,
  };
}

/** Calls `fn` right away and then `ms` after each call ends, until stopped; an error is reported and the next call still comes. */
function every(clock: Clock, ms: number, fn: () => Promise<unknown>, onError: (err: unknown) => void): { stop(): Promise<void> } {
  let cancel = () => {};
  let current: Promise<void> = Promise.resolve();
  let stopped = false;
  const tick = () => {
    current = (async () => {
      try {
        await fn();
      } catch (err) {
        onError(err);
      }
      if (!stopped) cancel = clock.setTimer(ms, tick);
    })();
  };
  tick();
  return {
    stop: () => {
      stopped = true;
      cancel();
      return current;
    },
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
