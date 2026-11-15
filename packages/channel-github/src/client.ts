import { createPrivateKey } from "node:crypto";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GitHubConfig = {
  owner: string;
  repo: string;
  /** Issues and PRs carrying this label are the agent's to read. Default `"aoa"`. */
  label?: string;
  /** The one human whose words count as instructions. */
  userLogin: string;
  /** The App's own login, `<slug>[bot]`. */
  botLogin: string;
  appId: string;
  installationId: string;
  privateKeyPath: string;
  /** Default `https://api.github.com`. */
  apiBase?: string;
  fetch?: FetchFn;
  /** Milliseconds since the epoch. */
  now?: () => number;
};

export type Resolved = Required<GitHubConfig>;

/** `serverTime` comes from GitHub's `Date` header, falling back to the host clock if it is missing. */
export type Reply<T> = { data: T; serverTime: number; next: string | null };

export function resolve(config: GitHubConfig): Resolved {
  return {
    ...config,
    label: config.label ?? "aoa",
    apiBase: config.apiBase ?? "https://api.github.com",
    fetch: config.fetch ?? ((input, init) => fetch(input, init)),
    now: config.now ?? (() => Date.now()),
  };
}

/** Installation tokens live an hour; take a new one well before that so a request never races the expiry. */
const REFRESH_BEFORE_MS = 5 * 60_000;
const REDACTED = "[redacted]";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * Every call to GitHub goes through here, so this is the one place that holds the App key and the
 * installation token, and the one place that strips them from anything it lets out.
 */
export class GitHubClient {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private signingKey: Promise<CryptoKey> | null = null;
  private readonly secrets = new Set<string>();
  private readonly origin: string;
  private readonly base: string;

  constructor(private readonly cfg: Resolved) {
    this.base = cfg.apiBase.replace(/\/+$/, "");
    this.origin = new URL(this.base).origin;
  }

  /** Registers a value derived from a secret (e.g. a Basic auth header) so `scrub` removes it too. */
  addSecret(value: string): void {
    if (value) this.secrets.add(value);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    return out
      .replace(/\bgh[opsu]_[A-Za-z0-9_]+/g, REDACTED)
      .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, REDACTED)
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(-----END [^-]*PRIVATE KEY-----|$)/g, REDACTED);
  }

  async installationToken(): Promise<string> {
    const now = this.cfg.now();
    if (this.token && now < this.token.expiresAt - REFRESH_BEFORE_MS) return this.token.value;
    this.refreshing ??= this.fetchToken().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.send<T>(method, path, body)).data;
  }

  /**
   * Reads every page of a list endpoint by following `Link: rel="next"`. `serverTime` is GitHub's clock
   * when the first page was served.
   */
  async paginate<T>(path: string): Promise<{ items: T[]; serverTime: number }> {
    const first = await this.send<T[]>("GET", path);
    const items = [...first.data];
    let next = first.next;
    while (next) {
      // The token travels with every page request, so never follow a link off the API host.
      if (new URL(next).origin !== this.origin) {
        throw new GitHubError(`GitHub pagination pointed outside ${this.origin}`, null);
      }
      const page: Reply<T[]> = await this.send<T[]>("GET", next);
      items.push(...page.data);
      next = page.next;
    }
    return { items, serverTime: first.serverTime };
  }

  async send<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const token = await this.installationToken();
    return this.call<T>(method, path, `Bearer ${token}`, body);
  }

  private async call<T>(
    method: string,
    path: string,
    authorization: string,
    body?: unknown,
  ): Promise<Reply<T>> {
    const url = path.startsWith("https://") || path.startsWith("http://") ? path : `${this.base}${path}`;
    const where = `GitHub ${method} ${new URL(url).pathname}`;
    let response: Response;
    let text: string;
    try {
      response = await this.cfg.fetch(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization,
          "x-github-api-version": "2022-11-28",
          "user-agent": "aoa",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await response.text();
    } catch (err) {
      // A fresh error, never `cause: err`: the original may carry the request and its headers.
      throw new GitHubError(this.scrub(`${where} failed: ${err instanceof Error ? err.message : String(err)}`), null);
    }
    if (!response.ok) {
      // Scrub before truncating: a secret cut in half would no longer match.
      const detail = this.scrub(text).slice(0, 1000);
      throw new GitHubError(this.scrub(`${where} failed with ${response.status}: ${detail}`), response.status);
    }
    const date = Date.parse(response.headers.get("date") ?? "");
    return {
      data: (text ? JSON.parse(text) : null) as T,
      serverTime: isNaN(date) ? this.cfg.now() : date,
      next: nextLink(response.headers.get("link")),
    };
  }

  private async fetchToken(): Promise<string> {
    const jwt = await this.appJwt();
    this.addSecret(jwt);
    const { data, serverTime } = await this.call<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${encodeURIComponent(this.cfg.installationId)}/access_tokens`,
      `Bearer ${jwt}`,
    );
    this.addSecret(data.token);
    // Measured as a lifetime on GitHub's clock, so a skewed host clock cannot keep a dead token.
    this.token = { value: data.token, expiresAt: this.cfg.now() + (Date.parse(data.expires_at) - serverTime) };
    return data.token;
  }

  private async appJwt(): Promise<string> {
    this.signingKey ??= loadSigningKey(this.cfg.privateKeyPath);
    const key = await this.signingKey;
    const now = Math.floor(this.cfg.now() / 1000);
    const iss = /^\d+$/.test(this.cfg.appId) ? Number(this.cfg.appId) : this.cfg.appId;
    // Backdated a minute against clock drift; GitHub rejects an `exp` more than ten minutes out.
    const claims = { iat: now - 60, exp: now + 9 * 60, iss };
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  }
}

async function loadSigningKey(path: string): Promise<CryptoKey> {
  let pkcs8: Uint8Array<ArrayBuffer>;
  try {
    // GitHub hands out PKCS#1 keys and WebCrypto imports only PKCS#8, so convert first.
    pkcs8 = new Uint8Array(createPrivateKey(await Bun.file(path).text()).export({ format: "der", type: "pkcs8" }));
  } catch {
    throw new GitHubError(`Could not read the GitHub App private key at ${path}`, null);
  }
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1] ?? null;
  }
  return null;
}
