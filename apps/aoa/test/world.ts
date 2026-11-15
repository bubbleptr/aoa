import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitRunner, runGitWithBun } from "@aoa/channel-github";
import { FakeClock } from "@aoa/conformance";
import {
  type AssistantMessage,
  type Context,
  type Message,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { type Agent, assemble } from "../src/wiring.ts";
import { type AgentConfigInput, validateConfig } from "../src/config.ts";
import { main } from "../src/main.ts";
import { APP_ID, BOT, FakeGitHub, INSTALLATION_ID, OWNER, REPO, USER, writeAppKey } from "../../../packages/channel-github/test/fake-github.ts";

export { BOT, OWNER, REPO, USER };

export const MODEL_KEY = "sk-model-secret-5f1e9c2a7b";
export const KEY_ENV = "AOA_TEST_MODEL_KEY";
const key = writeAppKey();
const configModule = join(import.meta.dir, "../src/config.ts");

export type Step = AssistantMessage | ((messages: Message[]) => AssistantMessage | Promise<AssistantMessage>);

export const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export const say = (text: string) => fauxAssistantMessage(text);

/** The text of the last tool result the model was shown. */
export function lastResult(messages: Message[]): string {
  const m = messages.findLast((x) => x.role === "toolResult");
  if (!m || m.role !== "toolResult") throw new Error("no tool result yet");
  return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await runGitWithBun(args, { cwd, env: {} });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Everything the agent touches, local and in memory: a git repo whose origin is a bare repo, an in-memory
 * GitHub behind `fetch`, scripted models for the agent and the classifier, and one fake clock for all of it.
 */
export class World {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "aoa-e2e-")));
  readonly repo = join(this.root, "repo");
  readonly origin = join(this.root, "origin.git");
  readonly gh = new FakeGitHub(key.publicKeyPem);
  readonly clock = new FakeClock(this.gh.now);
  readonly logs: string[] = [];
  readonly outputs: string[] = [];
  /** Every request each scripted model received. */
  readonly modelRequests: Context[] = [];
  readonly pushes: { args: string[]; env: Record<string, string> }[] = [];
  /** The classifier's verdict for a call, given the text it was shown. */
  judge: (shown: string) => string = () => "allow";
  readonly configPath = join(this.root, "aoa.config.ts");
  readonly config: AgentConfigInput;
  private readonly agentModel = fauxProvider({ provider: "scripted", models: [{ id: "agent" }] });
  private readonly judgeModel = fauxProvider({ provider: "judge", models: [{ id: "judge" }] });
  agent!: Agent;

  /** The environment the agent reads its model key from; `process.env` to test what child processes inherit. */
  readonly env: Record<string, string | undefined>;

  constructor(o: { classifier?: boolean; env?: Record<string, string | undefined> } = {}) {
    this.env = o.env ?? { [KEY_ENV]: MODEL_KEY };
    this.config = {
      dataDir: join(this.root, "data"),
      repo: { path: this.repo, base: "main" },
      model: { provider: "scripted", modelId: "agent", apiKeyEnv: KEY_ENV },
      ...(o.classifier === false ? {} : { classifier: { provider: "judge", modelId: "judge", apiKeyEnv: KEY_ENV } }),
      github: {
        owner: OWNER,
        repo: REPO,
        label: "aoa",
        userLogin: USER,
        botLogin: BOT,
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        privateKeyPath: key.path,
      },
      rate: { maxMsgs: 100, windowMs: 3_600_000, minIntervalMs: 0 },
    };
    this.judgeModel.setResponses(
      Array.from({ length: 200 }, () => (context: Context) => {
        this.modelRequests.push(context);
        const shown = JSON.stringify(context.messages);
        return fauxAssistantMessage(this.judge(shown));
      }),
    );
  }

  /** The real GitHub API host goes to the fake; nothing leaves the process. */
  readonly fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return this.gh.fetch(url.replace(/^https:\/\/api\.github\.com/, "https://api.github.test"), init);
  };

  /** Real git, with pushes to GitHub's clone URL sent to the local bare repo instead. */
  readonly runGit: GitRunner = async (args, opts) => {
    if (args[0] === "push") {
      this.pushes.push({ args, env: opts.env });
      args = ["push", this.origin, ...args.slice(2)];
    }
    return runGitWithBun(args, opts);
  };

  get seams() {
    return {
      fetch: this.fetch,
      runGit: this.runGit,
      providers: [this.agentModel.provider, this.judgeModel.provider],
      clock: this.clock,
      env: this.env,
      log: (line: string) => this.logs.push(line),
    };
  }

  async start(): Promise<this> {
    await git(["init", "--bare", "-b", "main", this.origin], this.root);
    await git(["init", "-b", "main", this.repo], this.root);
    await git(["config", "user.name", "Test User"], this.repo);
    await git(["config", "user.email", "test@example.com"], this.repo);
    await git(["config", "commit.gpgsign", "false"], this.repo);
    writeFileSync(join(this.repo, "README.md"), "# widgets\n");
    await git(["add", "README.md"], this.repo);
    await git(["commit", "-qm", "Initial commit"], this.repo);
    await git(["remote", "add", "origin", this.origin], this.repo);
    await git(["push", "-q", "origin", "main"], this.repo);

    writeFileSync(
      this.configPath,
      `import { defineAgent } from ${JSON.stringify(configModule)};\nexport default defineAgent(${JSON.stringify(this.config, null, 2)});\n`,
    );
    this.agent = assemble(validateConfig(this.config), this.seams);
    // A first poll only sets the cursor; GitHub items after it are new.
    await this.agent.poller.pass();
    this.advance(1000);
    return this;
  }

  script(steps: Step[]): void {
    this.agentModel.setResponses(
      steps.map((step) => (context: Context) => {
        this.modelRequests.push(context);
        return typeof step === "function" ? step(context.messages) : step;
      }),
    );
  }

  pendingSteps(): number {
    return this.agentModel.getPendingResponseCount();
  }

  advance(ms: number): void {
    this.gh.advance(ms);
    this.clock.advance(ms);
  }

  poll() {
    return this.agent.poller.pass();
  }

  /** Waits out the worker's debounce, then runs everything ready. */
  async drain() {
    this.advance(2000);
    return this.agent.worker.drain();
  }

  dispatch() {
    return this.agent.dispatcher.pass();
  }

  /** Runs the CLI as another process would: same config file, its own store connection. */
  async cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const code = await main([...argv, "--config", this.configPath], {
      cwd: this.root,
      out: (t) => (out += `${t}\n`),
      err: (t) => (err += `${t}\n`),
      seams: this.seams,
    });
    this.outputs.push(out, err);
    return { code, out, err };
  }

  runs() {
    return this.agent.store.tx((t) => t.listRuns(this.agent.inboxId));
  }

  sessions() {
    return this.agent.store.tx((t) => t.listSessions(this.agent.inboxId));
  }

  events() {
    return this.agent.store.tx((t) => t.listEvents(this.agent.inboxId));
  }

  originLog(ref: string): Promise<string> {
    return git(["--git-dir", this.origin, "log", "-1", "--format=%s", ref], this.root);
  }

  privateKeyPem(): string {
    return readFileSync(key.path, "utf8");
  }

  dispose(): void {
    this.agent?.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
