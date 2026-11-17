import { POLL_INTERVAL_MS } from "@aoa/kernel";
import type { Agent } from "./wiring.ts";

/** How often `serve` looks for work written by other processes (`aoa send`, `aoa answer`). */
export const NUDGE_INTERVAL_MS = 5_000;
/** How often `serve` checks the pull requests of open sessions (GitHub mode). */
export const PULL_CHECK_INTERVAL_MS = 5 * 60_000;
/** Cursors where `serve` records when it started and when it last nudged, for `aoa web` to tell whether it runs. */
export const SERVE_STARTED = "serve:started";
export const SERVE_SEEN = "serve:seen";

/**
 * Runs every agent's worker, scheduler, dispatcher, channel poller and finished-session check until `stop`
 * resolves, then stops them and waits for what is in flight. Polls once right away. The heartbeat is one, in the
 * default agent's inbox.
 */
export async function serve(agent: Agent, stop: Promise<void>): Promise<void> {
  const { clock, log } = agent;
  agent.log(`serving ${agent.agents.map((a) => a.inboxId).join(", ")}`);
  for (const a of agent.agents.filter((a) => a.permissions === "harness")) {
    log(
      a.role === "review"
        ? `agent ${a.name} runs on Codex in its read-only sandbox: it cannot change files or reach the network, and nothing it asks for reaches you`
        : `agent ${a.name} runs on Codex: Codex's own approval and sandbox settings govern what it does without asking, and aoa's push and ~/.aoa rules do not apply to Codex's own tools`,
    );
  }
  const startedAt = String(clock.now());
  agent.store.tx((t) => t.setCursor(agent.inboxId, SERVE_STARTED, startedAt));

  const repeating: { stop(): Promise<void> }[] = [];
  const every = (ms: number, what: string, fn: () => Promise<unknown> | void) => {
    let cancel = () => {};
    let current: Promise<void> = Promise.resolve();
    let stopped = false;
    const tick = () => {
      current = (async () => {
        try {
          await fn();
        } catch (err) {
          log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!stopped) cancel = clock.setTimer(ms, tick);
      })();
    };
    tick();
    repeating.push({
      stop: () => {
        stopped = true;
        cancel();
        return current;
      },
    });
  };

  const several = agent.agents.length > 1;
  const loops = agent.agents.flatMap((a) => {
    const of = (name: string) => (several ? `${name} of ${a.name}` : name);
    return [
      [of("worker"), a.worker],
      [of("scheduler"), a.scheduler],
      [of("dispatcher"), a.dispatcher],
    ] as const;
  });
  let failed: () => void = () => {};
  const failure = new Promise<void>((resolve) => (failed = resolve));
  const running = loops.map(([name, loop]) =>
    loop.serve().catch((err) => {
      log(`the ${name} stopped: ${err instanceof Error ? err.message : String(err)}`);
      failed();
    }),
  );

  for (const a of agent.agents) if (a.schedule.polls) every(POLL_INTERVAL_MS, "polling the channel", () => a.poller.pass());
  every(NUDGE_INTERVAL_MS, "waking the workers", () => {
    agent.store.tx((t) => t.setCursor(agent.inboxId, SERVE_SEEN, String(clock.now())));
    for (const a of agent.agents) {
      a.worker.wake();
      a.dispatcher.wake();
    }
  });
  for (const a of agent.agents) every(a.schedule.finishCheckMs, "closing finished sessions", () => a.closeFinished());

  await Promise.race([stop, failure]);
  for (const [, loop] of loops) loop.stop();
  await Promise.all([...repeating.map((r) => r.stop()), ...running]);
  log("stopped");
}
