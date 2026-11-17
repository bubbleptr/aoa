import type { Agent } from "./wiring.ts";

/** How often `serve` looks for work written by other processes (`aoa send`, `aoa answer`). */
export const NUDGE_INTERVAL_MS = 5_000;
/** How often `serve` checks the pull requests of open sessions (GitHub mode). */
export const PULL_CHECK_INTERVAL_MS = 5 * 60_000;
/** Cursors where `serve` records when it started and when it last nudged, for `aoa web` to tell whether it runs. */
export const SERVE_STARTED = "serve:started";
export const SERVE_SEEN = "serve:seen";

/**
 * Runs the host (every agent's worker, scheduler, dispatcher and channel poller) and the finished-session check until
 * `stop` resolves or a loop dies, then stops them and waits for what is in flight. The heartbeat is one, in the
 * default agent's inbox.
 */
export async function serve(agent: Agent, stop: Promise<void>): Promise<void> {
  const { clock, log } = agent;
  agent.log(`serving ${agent.agents.map((a) => a.inboxId).join(", ")}`);
  for (const a of agent.agents.filter((a) => a.permissions === "harness")) {
    log(
      a.runtime === "dsh"
        ? `agent ${a.name} runs on dsh: dsh's own sandbox and approval settings govern what it does without asking, and aoa's push and ~/.aoa rules do not apply to dsh's own tools`
        : a.role === "review"
          ? `agent ${a.name} runs on Codex with auto review: Codex's workspace-write sandbox and its auto review decide what it does, nothing it asks for reaches you, and aoa's read-only, push and ~/.aoa rules do not apply to Codex's own tools`
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

  agent.host.start();

  every(NUDGE_INTERVAL_MS, "waking the workers", () => {
    agent.store.tx((t) => t.setCursor(agent.inboxId, SERVE_SEEN, String(clock.now())));
    for (const a of agent.agents) a.wake();
  });
  for (const a of agent.agents) every(a.schedule.finishCheckMs, "closing finished sessions", () => a.closeFinished());

  await Promise.race([stop, agent.host.stopped]);
  await Promise.all([...repeating.map((r) => r.stop()), agent.host.stop()]);
  log("stopped");
}
