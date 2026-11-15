import type { Resolved } from "./client.ts";

export function threadKey(cfg: Resolved, number: number): string {
  return `github:${cfg.owner}/${cfg.repo}#${number}`;
}

/** The issue or PR number a thread key names; throws for anything outside the configured repo. */
export function threadNumber(cfg: Resolved, thread: string | null): number {
  if (thread === null) throw new Error("This message has no thread to post to");
  const m = thread.match(/^github:([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!m) throw new Error(`Not a GitHub thread: ${thread}`);
  const [, owner, repo, number] = m;
  if (owner?.toLowerCase() !== cfg.owner.toLowerCase() || repo?.toLowerCase() !== cfg.repo.toLowerCase()) {
    throw new Error(`Thread ${thread} is not in ${cfg.owner}/${cfg.repo}`);
  }
  return Number(number);
}

/** GitHub logins are case-insensitive. */
export function sameLogin(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
