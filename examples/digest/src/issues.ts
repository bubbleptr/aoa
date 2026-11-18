/** An issue as the digest sees it. Title and body are written by whoever opened it: untrusted text. */
export type Issue = {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  labels: string[];
  /** Milliseconds since the epoch. */
  updatedAt: number;
  body: string;
};

/** Where the issues come from. */
export interface IssueSource {
  /** Issues updated at or after `since`, newest first. */
  updatedSince(since: number): Promise<Issue[]>;
}

/**
 * GitHub's REST issue list for one repository, one page of at most 100. The endpoint also lists pull requests; they
 * are left out. `since` filters on the update time.
 */
export function githubIssues(o: { owner: string; repo: string; token?: string; fetch?: typeof fetch }): IssueSource {
  const get = o.fetch ?? fetch;
  return {
    async updatedSince(since) {
      const url = new URL(`https://api.github.com/repos/${o.owner}/${o.repo}/issues`);
      url.search = new URLSearchParams({ state: "all", sort: "updated", direction: "desc", per_page: "100", since: new Date(since).toISOString() }).toString();
      const res = await get(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "aoa-example-digest",
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} for the issues of ${o.owner}/${o.repo}`);
      const items = (await res.json()) as {
        number: number;
        title: string;
        html_url: string;
        state: "open" | "closed";
        labels: (string | { name?: string })[];
        updated_at: string;
        body: string | null;
        pull_request?: unknown;
      }[];
      return items
        .filter((i) => i.pull_request === undefined)
        .map((i) => ({
          number: i.number,
          title: i.title,
          url: i.html_url,
          state: i.state,
          labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter((l) => l !== ""),
          updatedAt: Date.parse(i.updated_at),
          body: i.body ?? "",
        }));
    },
  };
}
