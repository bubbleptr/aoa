import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubConfig } from "../src/index.ts";

export const API = "https://api.github.test";
export const OWNER = "acme";
export const REPO = "widgets";
export const BOT = "aoa-agent[bot]";
export const USER = "kieran";
export const APP_ID = "4242";
export const INSTALLATION_ID = "777";

type Issue = {
  number: number;
  title: string;
  body: string;
  author: string | null;
  labels: string[];
  pr: { head: string; base: string; state: "open" | "closed"; merged: boolean } | null;
  createdAt: number;
  updatedAt: number;
};

type Comment = { id: number; issue: number; author: string; body: string; createdAt: number; updatedAt: number };

/** The next request (or the next one matching `METHOD /path`) fails with `status`. */
type Failure = { status: number; echoAuth?: boolean; match?: string };

/** GitHub as App keys are issued: PKCS#1 PEM. */
export function writeAppKey(): { path: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const dir = mkdtempSync(join(tmpdir(), "aoa-gh-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey);
  return { path, publicKeyPem: publicKey };
}

const SECOND = 1000;
const iso = (ms: number) => new Date(Math.floor(ms / SECOND) * SECOND).toISOString().replace(".000Z", "Z");

/**
 * An in-memory GitHub behind `fetch`: one repo, one App installation. Timestamps have whole-second
 * precision, `since` is inclusive, and list endpoints paginate with absolute `Link` URLs like the real API.
 */
export class FakeGitHub {
  now = Date.parse("2026-11-16T09:00:00Z");
  /** Caps `per_page` so tests can force pagination with few items. */
  maxPerPage = 100;
  defaultBranch = "main";
  tokenRequests = 0;
  readonly issuedTokens: string[] = [];
  /** Every request the fake served, as `METHOD path`. */
  readonly requests: string[] = [];
  private failures: Failure[] = [];
  private tokens = new Map<string, number>();
  private issues = new Map<number, Issue>();
  private comments: Comment[] = [];
  private nextNumber = 1;
  private nextCommentId = 1000;
  private publicKey: Promise<CryptoKey>;

  constructor(publicKeyPem: string) {
    const der = Buffer.from(publicKeyPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    this.publicKey = crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
  }

  config(privateKeyPath: string): GitHubConfig {
    return {
      owner: OWNER,
      repo: REPO,
      userLogin: USER,
      botLogin: BOT,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyPath,
      apiBase: API,
      fetch: this.fetch,
      now: () => this.now,
    };
  }

  advance(ms: number): void {
    this.now += ms;
  }

  fail(f: Failure): void {
    this.failures.push(f);
  }

  addIssue(o: { author: string | null; title?: string; body?: string; labels?: string[] }): number {
    const number = this.nextNumber++;
    this.issues.set(number, {
      number,
      title: o.title ?? `issue ${number}`,
      body: o.body ?? "",
      author: o.author,
      labels: o.labels ?? [],
      pr: null,
      createdAt: this.now,
      updatedAt: this.now,
    });
    return number;
  }

  addComment(issue: number, author: string, body: string): number {
    const id = this.nextCommentId++;
    this.comments.push({ id, issue, author, body, createdAt: this.now, updatedAt: this.now });
    this.touch(issue);
    return id;
  }

  editComment(id: number, body: string): void {
    const c = this.comments.find((x) => x.id === id);
    if (!c) throw new Error(`no comment ${id}`);
    c.body = body;
    c.updatedAt = this.now;
  }

  commentsOn(issue: number): Comment[] {
    return this.comments.filter((c) => c.issue === issue);
  }

  issue(number: number): Issue | undefined {
    return this.issues.get(number);
  }

  /** Closes a pull request, merging it first when `merged`. */
  closePull(number: number, merged = false): void {
    const pr = this.issues.get(number)?.pr;
    if (!pr) throw new Error(`no pull request ${number}`);
    pr.state = "closed";
    pr.merged = merged;
    this.touch(number);
  }

  openPulls(): Issue[] {
    return [...this.issues.values()].filter((i) => i.pr?.state === "open");
  }

  private touch(number: number): void {
    const i = this.issues.get(number);
    if (i) i.updatedAt = this.now;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await this.handle(input, init);
    response.headers.set("date", new Date(this.now).toUTCString());
    return response;
  };

  private handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    this.requests.push(`${method} ${url.pathname}`);
    if (url.origin !== API) throw new Error(`fake GitHub got a request for ${url.origin}`);

    const at = this.failures.findIndex((f) => f.match === undefined || f.match === `${method} ${url.pathname}`);
    const failure = at >= 0 ? this.failures.splice(at, 1)[0] : undefined;
    if (failure) {
      const body: Record<string, unknown> = { message: "Something went wrong" };
      if (failure.echoAuth) body.request = { authorization: headers.get("authorization") };
      return json(failure.status, body);
    }

    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;

    if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return this.issueToken(headers.get("authorization"));
    }

    const auth = headers.get("authorization") ?? "";
    const token = auth.replace(/^(Bearer|token) /, "");
    const expires = this.tokens.get(token);
    if (expires === undefined || expires <= this.now) return json(401, { message: "Bad credentials" });

    const prefix = `/repos/${OWNER}/${REPO}`;
    if (!path.startsWith(prefix)) return json(404, { message: "Not Found" });
    const rest = path.slice(prefix.length);
    let m: RegExpMatchArray | null;

    if (method === "GET" && rest === "") {
      return json(200, {
        full_name: `${OWNER}/${REPO}`,
        default_branch: this.defaultBranch,
        clone_url: `https://github.test/${OWNER}/${REPO}.git`,
      });
    }
    if (method === "GET" && rest === "/issues") {
      const labels = url.searchParams.get("labels")?.split(",").filter(Boolean) ?? [];
      const state = url.searchParams.get("state") ?? "open";
      const since = sinceOf(url);
      const items = [...this.issues.values()]
        .filter((i) => labels.every((l) => i.labels.includes(l)))
        .filter((i) => state === "all" || (i.pr?.state ?? "open") === state)
        .filter((i) => i.updatedAt >= since);
      return this.page(url, sorted(items, url), (i) => this.issueJson(i));
    }
    if (method === "POST" && rest === "/issues") {
      const number = this.addIssue({ author: BOT, title: body.title, body: body.body, labels: body.labels ?? [] });
      return json(201, this.issueJson(this.issues.get(number)!));
    }
    if ((m = rest.match(/^\/issues\/(\d+)$/)) && method === "GET") {
      const i = this.issues.get(Number(m[1]));
      return i ? json(200, this.issueJson(i)) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && rest === "/issues/comments") {
      const since = sinceOf(url);
      const items = this.comments.filter((c) => c.updatedAt >= since);
      return this.page(url, sorted(items, url), (c) => this.commentJson(c));
    }
    if ((m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
      const number = Number(m[1]);
      if (!this.issues.has(number)) return json(404, { message: "Not Found" });
      if (method === "GET") {
        const since = sinceOf(url);
        const items = this.comments.filter((c) => c.issue === number && c.updatedAt >= since);
        return this.page(url, items, (c) => this.commentJson(c));
      }
      if (method === "POST") {
        const id = this.addComment(number, BOT, body.body);
        return json(201, this.commentJson(this.comments.find((c) => c.id === id)!));
      }
    }
    if ((m = rest.match(/^\/issues\/(\d+)\/labels$/)) && method === "POST") {
      const i = this.issues.get(Number(m[1]));
      if (!i) return json(404, { message: "Not Found" });
      for (const l of body.labels as string[]) if (!i.labels.includes(l)) i.labels.push(l);
      i.updatedAt = this.now;
      return json(200, i.labels.map((name) => ({ name })));
    }
    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      // Like GitHub, a `head` filter without the `owner:` prefix is ignored.
      const branch = head?.startsWith(`${OWNER}:`) ? head.slice(OWNER.length + 1) : null;
      const items = [...this.issues.values()]
        .filter((i) => i.pr && (state === "all" || i.pr.state === state))
        .filter((i) => branch === null || i.pr?.head === branch);
      return this.page(url, items, (i) => this.pullJson(i));
    }
    if ((m = rest.match(/^\/pulls\/(\d+)$/)) && method === "GET") {
      const i = this.issues.get(Number(m[1]));
      return i?.pr ? json(200, this.pullJson(i)) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && rest === "/pulls") {
      if (this.openPulls().some((p) => p.pr?.head === body.head)) {
        return json(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists" }] });
      }
      const number = this.addIssue({ author: BOT, title: body.title, body: body.body });
      this.issues.get(number)!.pr = { head: body.head, base: body.base, state: "open", merged: false };
      return json(201, this.pullJson(this.issues.get(number)!));
    }
    return json(404, { message: "Not Found" });
  };

  private async issueToken(auth: string | null): Promise<Response> {
    const jwt = auth?.replace(/^Bearer /, "") ?? "";
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return json(401, { message: "A JSON web token could not be decoded" });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await this.publicKey,
      Buffer.from(s, "base64url"),
      new TextEncoder().encode(`${h}.${p}`),
    );
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const nowS = this.now / SECOND;
    if (!ok || String(claims.iss) !== APP_ID || claims.exp <= nowS || claims.iat > nowS + 60) {
      return json(401, { message: "'Expiration time' claim ('exp') is invalid" });
    }
    this.tokenRequests++;
    const token = `ghs_fake${this.tokenRequests}x${Math.random().toString(36).slice(2)}`;
    const expiresAt = this.now + 60 * 60 * SECOND;
    this.tokens.set(token, expiresAt);
    this.issuedTokens.push(token);
    return json(201, { token, expires_at: iso(expiresAt) });
  }

  private page<T>(url: URL, items: T[], render: (t: T) => unknown): Response {
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), this.maxPerPage);
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(url.href);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.href}>; rel="next", <${url.href}>; rel="first"`;
    }
    return json(200, slice.map(render), headers);
  }

  private issueJson(i: Issue) {
    return {
      number: i.number,
      title: i.title,
      body: i.body || null,
      user: i.author === null ? null : { login: i.author },
      labels: i.labels.map((name) => ({ name })),
      html_url: `https://github.test/${OWNER}/${REPO}/${i.pr ? "pull" : "issues"}/${i.number}`,
      created_at: iso(i.createdAt),
      updated_at: iso(i.updatedAt),
      ...(i.pr ? { pull_request: { url: `${API}/repos/${OWNER}/${REPO}/pulls/${i.number}` } } : {}),
    };
  }

  private commentJson(c: Comment) {
    return {
      id: c.id,
      body: c.body,
      user: { login: c.author },
      html_url: `https://github.test/${OWNER}/${REPO}/issues/${c.issue}#issuecomment-${c.id}`,
      issue_url: `${API}/repos/${OWNER}/${REPO}/issues/${c.issue}`,
      created_at: iso(c.createdAt),
      updated_at: iso(c.updatedAt),
    };
  }

  private pullJson(i: Issue) {
    return {
      number: i.number,
      state: i.pr!.state,
      merged: i.pr!.merged,
      title: i.title,
      html_url: `https://github.test/${OWNER}/${REPO}/pull/${i.number}`,
      head: { ref: i.pr!.head, label: `${OWNER}:${i.pr!.head}` },
      base: { ref: i.pr!.base },
    };
  }
}

function sinceOf(url: URL): number {
  const since = url.searchParams.get("since");
  return since ? Math.floor(Date.parse(since) / SECOND) * SECOND : 0;
}

function sorted<T extends { createdAt: number; updatedAt: number }>(items: T[], url: URL): T[] {
  const key = url.searchParams.get("sort") === "updated" ? "updatedAt" : "createdAt";
  const dir = url.searchParams.get("direction") === "asc" ? 1 : -1;
  return [...items].sort((a, b) => (a[key] - b[key]) * dir);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
