import { POLL_INTERVAL_MS } from "@aoa/kernel";
import type { Agent } from "./wiring.ts";

/** How often `serve` looks for work written by other processes (`aoa send`, `aoa answer`). */
export const NUDGE_INTERVAL_MS = 5_000;
/** How often `serve` checks the pull requests of open sessions (GitHub mode). */
export const PULL_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Runs the worker, scheduler, dispatcher and channel poller until `stop` resolves, then stops them and
 * waits for what is in flight. Polls once right away.
 */
export async function serve(agent: Agent, stop: Promise<void>): Promise<void> {
  const { clock, log } = agent;
  agent.log(`serving ${agent.inboxId}`);

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

  const loops = [
    ["worker", agent.worker],
    ["scheduler", agent.scheduler],
    ["dispatcher", agent.dispatcher],
  ] as const;
  let failed: () => void = () => {};
  const failure = new Promise<void>((resolve) => (failed = resolve));
  const running = loops.map(([name, loop]) =>
    loop.serve().catch((err) => {
      log(`the ${name} stopped: ${err instanceof Error ? err.message : String(err)}`);
      failed();
    }),
  );

  if (agent.schedule.polls) every(POLL_INTERVAL_MS, "polling the channel", () => agent.poller.pass());
  every(NUDGE_INTERVAL_MS, "waking the worker", () => {
    agent.worker.wake();
    agent.dispatcher.wake();
  });
  every(agent.schedule.finishCheckMs, "closing finished sessions", () => agent.closeFinished());

  await Promise.race([stop, failure]);
  for (const [, loop] of loops) loop.stop();
  await Promise.all([...repeating.map((r) => r.stop()), ...running]);
  log("stopped");
}
