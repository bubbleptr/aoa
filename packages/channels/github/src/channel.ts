import type { Channel, NewEvent, OutMsg } from "@aoa/kernel";
import { type GitHubConfig, GitHubClient, type Resolved, resolve } from "./client.ts";
import { sameLogin, threadKey, threadNumber } from "./thread.ts";

type User = { login: string } | null;
type IssueJson = {
  number: number;
  title: string;
  body: string | null;
  user: User;
  labels: Array<{ name: string } | string>;
  html_url: string;
  updated_at: string;
};
type CommentJson = {
  id: number;
  body: string | null;
  user: User;
  html_url: string;
  issue_url: string;
  created_at: string;
  updated_at: string;
};

/** `since` is on GitHub's clock (its `Date` header), never the host's, so clock skew cannot open a gap. */
type Cursor = { since: string };

/**
 * Each poll re-reads this much before the previous one, so an item that becomes visible late (replica
 * lag, whole-second timestamps, an inclusive or exclusive `since`) is still picked up. The repeats are
 * dropped by the kernel's `dedupeKey`.
 */
const OVERLAP_MS = 60_000;
/** How far before `createdAt` deliver looks for its own marker, allowing for host and GitHub clocks to disagree. */
const CLOCK_SKEW_MS = 5 * 60_000;

const ANSWER_LINE = "Reply `/approve` to let this go ahead, or `/deny` followed by a reason to stop it.";

export type GitHubChannel = Channel & Pick<Required<Channel>, "poll"> & {
  /** Creates a labelled issue as the App and returns its thread key. */
  openThread(title: string, body: string): Promise<string>;
  pullState(number: number): Promise<"open" | "merged" | "closed">;
};

export function githubChannel(config: GitHubConfig): GitHubChannel {
  const cfg = resolve(config);
  const client = new GitHubClient(cfg);
  const repoPath = `/repos/${enc(cfg.owner)}/${enc(cfg.repo)}`;

  return {
    async poll(cursor) {
      if (cursor === null) {
        const { serverTime } = await client.send("GET", repoPath);
        return { events: [], cursor: encodeCursor({ since: iso(serverTime) }) };
      }
      const { since } = parseCursor(cursor);
      // Sorted by creation, which an update cannot change, so no item moves across a page boundary mid-walk.
      const { items: issues, serverTime } = await client.paginate<IssueJson>(
        `${repoPath}/issues?labels=${enc(cfg.label)}&state=all&sort=created&direction=asc&since=${since}&per_page=100`,
      );
      const { items: comments } = await client.paginate<CommentJson>(
        `${repoPath}/issues/comments?sort=created&direction=asc&since=${since}&per_page=100`,
      );

      const events: NewEvent[] = [];
      const labelled = new Map<number, boolean>();
      for (const issue of issues) {
        labelled.set(issue.number, true);
        if (sameLogin(issue.user?.login, cfg.botLogin)) continue;
        events.push(
          event(cfg, issue.user, `issue:${issue.number}`, issue.number, {
            kind: "issue",
            number: issue.number,
            title: issue.title,
            body: issue.body ?? "",
            text: `${issue.title}\n\n${issue.body ?? ""}`,
            author: issue.user?.login ?? null,
            url: issue.html_url,
          }),
        );
      }
      for (const comment of comments) {
        if (sameLogin(comment.user?.login, cfg.botLogin)) continue;
        const number = Number(comment.issue_url.split("/").pop());
        if (!labelled.has(number)) {
          const parent = await client.request<IssueJson>("GET", `${repoPath}/issues/${number}`);
          labelled.set(number, hasLabel(parent, cfg.label));
        }
        if (!labelled.get(number)) continue;
        events.push(
          event(cfg, comment.user, `comment:${comment.id}`, number, {
            kind: "comment",
            number,
            id: comment.id,
            body: comment.body ?? "",
            // The kernel reads `text`, not `body`, when it takes the user's reply as an answer to a deferred call.
            text: comment.body ?? "",
            author: comment.user?.login ?? null,
            url: comment.html_url,
          }),
        );
      }

      // Anything committed after the first list was served has a later `updated_at` than this.
      const next = Math.max(Date.parse(since), serverTime - OVERLAP_MS);
      return { events, cursor: encodeCursor({ since: iso(next) }) };
    },

    async deliver(m: OutMsg) {
      const number = threadNumber(cfg, m.thread);
      const marker = `<!-- aoa:${m.dedupeKey} -->`;
      const { items: recent } = await client.paginate<CommentJson>(
        `${repoPath}/issues/${number}/comments?since=${iso(m.createdAt - CLOCK_SKEW_MS)}&per_page=100`,
      );
      // Only the App's own comment counts, or anyone could suppress a message by quoting its marker.
      if (recent.some((c) => sameLogin(c.user?.login, cfg.botLogin) && c.body?.includes(marker))) return;
      const text = m.kind === "approval_request" ? `${m.body}\n\n${ANSWER_LINE}` : m.body;
      await client.request("POST", `${repoPath}/issues/${number}/comments`, { body: `${text}\n\n${marker}` });
    },

    async openThread(title, body) {
      const issue = await client.request<IssueJson>("POST", `${repoPath}/issues`, { title, body, labels: [cfg.label] });
      return threadKey(cfg, issue.number);
    },

    async pullState(number) {
      const pr = await client.request<{ state: "open" | "closed"; merged: boolean }>("GET", `${repoPath}/pulls/${number}`);
      return pr.merged ? "merged" : pr.state;
    },
  };
}

function event(cfg: Resolved, user: User, dedupeKey: string, number: number, payload: unknown): NewEvent {
  const trusted = sameLogin(user?.login, cfg.userLogin);
  return { source: trusted ? "user_message" : "webhook", trusted, dedupeKey, thread: threadKey(cfg, number), payload };
}

function hasLabel(issue: IssueJson, label: string): boolean {
  return issue.labels.some((l) => (typeof l === "string" ? l : l.name) === label);
}

function encodeCursor(c: Cursor): string {
  return JSON.stringify(c);
}

function parseCursor(cursor: string): Cursor {
  const c = JSON.parse(cursor) as Partial<Cursor>;
  if (typeof c.since !== "string" || isNaN(Date.parse(c.since))) throw new Error(`Not a GitHub poll cursor: ${cursor}`);
  return { since: c.since };
}

/** Whole seconds, the precision of GitHub's `since`. */
function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const enc = encodeURIComponent;
