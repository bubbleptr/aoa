import {
  ChannelPoller,
  Dispatcher,
  Scheduler,
  Worker,
  addFollowUp,
  answerDeferred,
  appendInTx,
  askUserTools,
  closeSession,
  memoryTools,
  outboxTools,
  putSchedule,
  reader,
  systemClock,
  timerTools,
  POLL_INTERVAL_MS,
  type AgentRuntime,
  type AppendResult,
  type CallId,
  type Channel,
  type Clock,
  type DispatchResult,
  type DrainResult,
  type FollowUpInput,
  type InboxId,
  type Memory,
  type MsgId,
  type NewEvent,
  type OutboxRow,
  type PendingCall,
  type PassResult,
  type PolicyConfig,
  type RatePolicy,
  type Reader,
  type RunOutcome,
  type ScheduleInput,
  type Session,
  type SessionId,
  type Store,
  type TimerId,
  type ToolDef,
  type Tx,
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
  /**
   * The agent's tools. A list goes after the kernel's built-in ones (timers, notify, memory, ask_user). A function
   * gets the built-in ones and returns the whole list, in order, so it can place or leave out any of them.
   */
  tools?: ToolDef[] | ((builtins: ToolDef[]) => ToolDef[]);
  memory?: Memory;
  policy?: PolicyConfig;
  /**
   * Where the agent's messages go and, if it has `poll`, where outside events come from. Without a channel a message is
   * sent the moment it is written, and the caller reads it from `host.messages()`.
   */
  channel?: Channel;
  /** How often the host polls a channel that has `poll`. Default 60 seconds. */
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

/**
 * Thrown by `append` with `refuseWhileAwaitingApproval` when the event's session waits on an approval: the kernel
 * would take the text as the user's word on that call (design §12).
 */
export class AwaitingApproval extends Error {
  constructor(readonly pending: PendingCall) {
    super(`Session ${pending.sessionId} waits for an approval of call ${pending.callId}; answer it with answer().`);
    this.name = "AwaitingApproval";
  }
}

/** A message from any agent's outbox: `seq` orders them all in one queue, `sentAt` is when it was delivered. */
export type QueuedOutMsg = OutboxRow & { agent: string };

export interface Agent {
  readonly name: string;
  readonly inbox: InboxId;
  /**
   * Appends an event to the inbox and wakes the worker. It is as trusted as `e.trusted` says: who is calling is the
   * caller's to know. With `refuseWhileAwaitingApproval`, an event whose session waits on an approval (not a question)
   * throws `AwaitingApproval` and nothing is appended, in the same transaction.
   */
  append(e: NewEvent, o?: { refuseWhileAwaitingApproval?: boolean }): AppendResult;
  /**
   * Answers a call this agent waits on and wakes the worker. Only the first answer counts: a later one comes back
   * `dropped`. Throws if no call of this agent with that id waits.
   */
  answer(callId: CallId, a: { verdict: "approve" | "deny"; text?: string; via?: string }): AppendResult;
  /** Wakes one of the agent's sessions at `due`. */
  followUp(t: FollowUpInput): TimerId;
  /**
   * Creates the recurring timer `id`, or makes the agent's existing one match: called with what it already has, it
   * changes nothing, so a start-up script can call it on every start. The returned id is the one `cancelTimer` takes.
   */
  schedule(t: ScheduleInput & { id: string }): TimerId;
  /** Cancels an armed timer of this agent's; false if there is none with that id. */
  cancelTimer(id: TimerId): boolean;
  /** What the agent's inbox holds, read-only. */
  readonly read: Reader;
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
  /**
   * Runs every agent's worker, scheduler and dispatcher, and polls the channels that have `pollMs` (once right away).
   * A host runs once: `start()` again, also after `stop()`, throws.
   */
  start(): void;
  /** Stops the loops and waits for what is in flight. */
  stop(): Promise<void>;
  /** Settles once the host has stopped: after `stop()`, or after a loop died and the host stopped the rest. */
  readonly stopped: Promise<void>;
  /**
   * Every agent's messages in the order they were queued, oldest first. `since` is the id of a message already seen;
   * `limit` keeps the first ones after it.
   */
  messages(o?: { since?: MsgId; limit?: number }): QueuedOutMsg[];
}

const DEFAULT_DEBOUNCE_MS = 2000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Loops = {
  agent: Agent;
  worker: Worker;
  scheduler: Scheduler;
  dispatcher: Dispatcher | null;
  poller: ChannelPoller | null;
  pollMs: number;
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
    // Without a channel nothing would ever deliver a message, and what the user was told would stay empty (D-MEM-3).
    const deps = { store: spec.channel ? store : sentOnWrite(store, clock), clock, inboxId: spec.inbox };
    const builtins = [...timerTools(deps), ...outboxTools(deps), ...(spec.memory ? memoryTools(spec.memory) : []), ...askUserTools()];
    const tools = typeof spec.tools === "function" ? spec.tools(builtins) : [...builtins, ...(spec.tools ?? [])];
    // Named in run lines only when there is someone to tell it from.
    const runLine = (line: string) => log(all.length > 1 ? `${spec.name}: ${line}` : line);

    const channel: Channel | null = spec.channel
      ? {
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
    const poll = spec.channel?.poll?.bind(spec.channel);
    const poller = poll ? new ChannelPoller({ ...deps, channel: { poll }, onEvents: () => worker.wake() }) : null;

    const inRun = (id: SessionId) => store.tx((t) => t.listEvents(spec.inbox)).some((e) => e.status === "in_run" && e.resume === id);

    async function close(id: SessionId, o: { afterClose?: () => void } = {}): Promise<"closed" | "busy"> {
      const owned = store.tx((t) => t.getSession(id));
      if (owned === null || owned.inboxId !== spec.inbox) throw new Error(`Agent ${spec.name} has no session ${id}.`);
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

    const read = reader(store, spec.inbox);
    const awaitingApproval = (t: Tx, e: NewEvent) => {
      const sessionId = e.thread === undefined ? null : t.sessionForThread(spec.inbox, e.thread);
      const session = sessionId === null ? null : t.getSession(sessionId);
      if (!session || session.status !== "paused" || session.pending === null) return;
      const pending = t.getDeferred(session.pending);
      if (pending && pending.kind !== "question") throw new AwaitingApproval(pending);
    };

    const handle: Agent = {
      name: spec.name,
      inbox: spec.inbox,
      append(e, o = {}) {
        const result = store.tx((t) => {
          if (o.refuseWhileAwaitingApproval) awaitingApproval(t, e);
          return appendInTx(t, spec.inbox, clock.now(), e);
        });
        worker.wake();
        return result;
      },
      answer(callId, a) {
        const pending = store.tx((t) => t.getDeferred(callId));
        if (pending === null || pending.inboxId !== spec.inbox) throw new Error(`Agent ${spec.name} has no call ${callId} waiting for an answer.`);
        const result = answerDeferred(store, clock, spec.inbox, callId, a.verdict, a.text, a.via);
        worker.wake();
        return result;
      },
      followUp(t) {
        const session = store.tx((tx) => tx.getSession(t.sessionId));
        if (session === null || session.inboxId !== spec.inbox) throw new Error(`Agent ${spec.name} has no session ${t.sessionId}.`);
        const timer = addFollowUp(store, spec.inbox, t);
        scheduler.wake();
        return timer.id;
      },
      schedule({ id, ...t }) {
        // Scoped to the inbox: two agents' "daily" are two timers, and no caller id meets the kernel's own.
        const timer = putSchedule(store, clock, spec.inbox, `schedule:${spec.inbox}:${id}`, t);
        scheduler.wake();
        return timer.id;
      },
      cancelTimer(id) {
        const timer = store.tx((t) => t.getTimer(id));
        if (timer === null || timer.inboxId !== spec.inbox) return false;
        return store.tx((t) => t.cancelTimer(id));
      },
      read,
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
    all.push({ agent: handle, worker, scheduler, dispatcher, poller, pollMs: spec.pollMs ?? POLL_INTERVAL_MS });
    return handle;
  }

  let started = false;
  function start(): void {
    if (started) throw new Error("A host runs once: create another to start again.");
    started = true;
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
      a.poller ? [every(clock, a.pollMs, () => a.poller!.pass(), (err) => log(`polling the channel failed: ${errorText(err)}`))] : [],
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
    messages(o = {}) {
      const queued = store
        .tx((t) => all.flatMap((a) => t.listOutbox(a.agent.inbox).map((m): QueuedOutMsg => ({ ...m, agent: a.agent.name }))))
        .sort((x, y) => x.seq - y.seq);
      const at = o.since === undefined ? -1 : queued.findIndex((m) => m.id === o.since);
      if (o.since !== undefined && at < 0) throw new Error(`No message has the id ${o.since}.`);
      const after = queued.slice(at + 1);
      return o.limit === undefined ? after : after.slice(0, o.limit);
    },
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

/** A store whose messages are marked sent in the transaction that writes them, at the time they were written. */
function sentOnWrite(store: Store, clock: Clock): Store {
  return {
    tx: (fn) =>
      store.tx((t) => {
        const tx: Tx = Object.create(t);
        tx.insertOutMsg = (m) => {
          const id = t.insertOutMsg(m);
          if (t.markSending(id)) t.markSent(id, m.createdAt);
          return id;
        };
        return fn(tx);
      }),
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
