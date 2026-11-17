import { posix } from "node:path";
import type { CallId, Decision, SessionId } from "./types.ts";

export type Risk = "low" | "medium" | "high";

/** What the policy sees of a call. Nothing the model says about its own safety is part of it (spec §6.2). */
export type ToolCall = { tool: string; args: unknown };

export type PolicyContext = {
  /** The session has taken content from someone other than the user (design §6). */
  tainted: boolean;
  /** The session's working directory, so a rule can tell paths inside it from paths outside. */
  workdir: string | null;
  /** The call's identity, for a shadow judge that records under it. Absent when the policy runs on its own. */
  call?: { id: CallId; sessionId: SessionId };
};

/** A rule with an opinion returns a decision; `null` passes the call to the next rule. */
export type Rule = { name: string; match(call: ToolCall, ctx: PolicyContext): Decision | null };

export type PolicyConfig = {
  /** Per tool name; a tool not listed is `high`. */
  risk: Record<string, Risk>;
  /** Checked in order, before the risk tier. */
  rules?: Rule[];
  /** Judges `medium` calls. Missing, throwing or `unsure` means the user decides. */
  classify?: (call: ToolCall, ctx: PolicyContext) => Promise<"allow" | "block" | "unsure">;
};

export type Verdict = { decision: Decision; basis: string };

/** Decision order: first rule with an opinion, then the risk tier, `medium` through the classifier (spec §6.3). */
export async function decide(policy: PolicyConfig | undefined, call: ToolCall, ctx: PolicyContext): Promise<Verdict> {
  if (!policy) return { decision: "allow", basis: "no policy" };
  for (const rule of policy.rules ?? []) {
    const decision = rule.match(call, ctx);
    if (decision) return { decision, basis: `rule:${rule.name}` };
  }
  const risk = policy.risk[call.tool] ?? "high";
  if (risk === "low") return { decision: "allow", basis: "risk:low" };
  if (risk === "high") return { decision: "defer", basis: "risk:high" };
  if (!policy.classify) return { decision: "defer", basis: "classifier:missing" };
  let verdict: string;
  try {
    verdict = await policy.classify(call, ctx);
  } catch {
    return { decision: "defer", basis: "classifier:error" };
  }
  const decision: Decision = verdict === "allow" ? "allow" : verdict === "block" ? "block" : "defer";
  return { decision, basis: `classifier:${verdict}` };
}

// The rules below compare text, which a determined caller can evade (design §6). They are built so that
// evasion lands in the risk tier, never in an allow: only the read-only rule allows, and it accepts nothing
// but a plain command made of a narrow set of characters.

/** The command of a `bash` call; null for any other call. */
export const commandOf = (call: ToolCall): string | null => {
  if (call.tool !== "bash" || typeof call.args !== "object" || call.args === null) return null;
  const command = (call.args as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
};

/** Removes quoting and escapes, which split words without changing what the shell runs. */
const unquote = (command: string): string => command.replace(/\\\n/g, " ").replace(/['"\\]/g, "");

/** Simple commands, each as its words; command substitutions and subshells count as their own commands. */
function simpleCommands(command: string): string[][] {
  return unquote(command)
    .split(/\$\(|[;&|\n()`]/)
    .map((segment) => segment.split(/[\s{}<>]+/).filter((w) => w !== ""))
    .filter((words) => words.length > 0);
}

const programName = (word: string): string => word.split("/").pop()!;

type GitInvocation = { globals: string[]; sub: string | undefined; args: string[] };

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);

/** Every `git` invocation in a bash command, with its global options, subcommand and arguments. */
export function gitInvocations(command: string): GitInvocation[] {
  const found: GitInvocation[] = [];
  for (const words of simpleCommands(command)) {
    words.forEach((word, i) => {
      if (programName(word) !== "git") return;
      const globals: string[] = [];
      let j = i + 1;
      while (j < words.length && words[j]!.startsWith("-")) {
        globals.push(words[j]!);
        j += GIT_OPTIONS_WITH_VALUE.has(words[j]!) ? 2 : 1;
      }
      found.push({ globals, sub: words[j], args: words.slice(j + 1) });
    });
  }
  return found;
}

const bashRule = (name: string, test: (command: string, ctx: PolicyContext) => Decision | null): Rule => ({
  name,
  match(call, ctx) {
    const command = commandOf(call);
    return command === null ? null : test(command, ctx);
  },
});

const noSudo = bashRule("no-sudo", (command) =>
  simpleCommands(command).some((words) => words.some((w) => programName(w) === "sudo")) ? "block" : null,
);

const isForceFlag = (arg: string): boolean =>
  arg.startsWith("--force") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) || (arg.startsWith("+") && arg.length > 1);

const noForcePush = bashRule("no-force-push", (command) =>
  gitInvocations(command).some((g) => g.sub === "push" && g.args.some(isForceFlag)) ? "block" : null,
);

const noGitConfig = bashRule("no-git-config", (command) =>
  gitInvocations(command).some(
    (g) => g.sub === "config" || g.globals.some((o) => o === "-c" || o.startsWith("--config-env")),
  )
    ? "block"
    : null,
);

const REMOTE_CHANGES = new Set(["add", "set-url", "remove", "rm", "rename"]);

const noGitRemoteChange = bashRule("no-git-remote-change", (command) =>
  gitInvocations(command).some((g) => g.sub === "remote" && REMOTE_CHANGES.has(g.args.find((a) => !a.startsWith("-")) ?? ""))
    ? "block"
    : null,
);

const SHELL = "(?:ba|z|da|k)?sh";
const PIPE_TO_SHELL = new RegExp(`\\b(?:curl|wget)\\b[^;&]*\\|\\s*(?:sudo\\s+)?(?:\\S*/)?${SHELL}\\b`);
const SHELL_RUNS_DOWNLOAD = new RegExp(`\\b(?:${SHELL}|eval|source)\\b[^;&|]*(?:\\$\\(|\`|<\\()\\s*(?:curl|wget)\\b`);

const noPipeToShell = bashRule("no-pipe-to-shell", (command) => {
  const plain = unquote(command);
  return PIPE_TO_SHELL.test(plain) || SHELL_RUNS_DOWNLOAD.test(plain) ? "block" : null;
});

const ROOT_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "${HOME}", "${HOME}/", "${HOME}/*"]);

const noRmRoot = bashRule("no-rm-root", (command) =>
  unquote(command)
    .split(/\$\(|[;&|\n()`]/)
    .map((segment) => segment.trim().split(/\s+/))
    .some((words) => {
      const at = words.findIndex((w) => programName(w) === "rm");
      if (at < 0) return false;
      const args = words.slice(at + 1);
      const recursive = args.some((a) => a === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a));
      return recursive && args.some((a) => ROOT_TARGETS.has(a));
    })
    ? "block"
    : null,
);

// Case-insensitive because the default macOS file system is: `.SSH` opens `.ssh`.
const CREDENTIAL_PATH =
  /(?:^|[^\w.-])\.(?:ssh|aoa|npmrc|netrc|gnupg|aws|kube|docker|git-credentials|env)(?![\w-])|\.config\/gh(?![\w-])|id_rsa|id_ed25519|secrets\.json|auth\.json/i;

const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

function pathArgs(call: ToolCall): string[] {
  if (typeof call.args !== "object" || call.args === null) return [];
  const args = call.args as Record<string, unknown>;
  const keys = ["path", "file_path", "filePath", "glob", ...(call.tool === "find" ? ["pattern"] : [])];
  return keys.map((k) => args[k]).filter((v): v is string => typeof v === "string");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with every path into the session's own worktree written relative to it. The worktree may live under a
 * credential directory (the data directory), and the agent naming its own working directory must not look like
 * reaching for credentials. A path that climbs back out with `..` is left as written.
 */
export function ownWorktreeRelative(text: string, workdir: string | null): string {
  if (workdir === null) return text;
  const root = posix.normalize(workdir).replace(/\/+$/, "");
  return text.replace(new RegExp(`${escapeRegExp(root)}(?=$|[/\\s;&|()<>'"\`])([^\\s;&|()<>'"\`]*)`, "g"), (whole, rest: string) => {
    const relative = posix.relative(root, posix.normalize(root + rest));
    return relative === ".." || relative.startsWith("../") ? whole : `./${relative}`;
  });
}

const HEREDOC = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w.-]+))/g;
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "eval", "source"]);

/**
 * The command without the bodies of heredocs that no shell reads. Such a body is data or another language's code
 * (a script editing docs that mention `~/.aoa`), not a path the shell opens. A body on a line that runs a shell
 * stays, and so does everything when a terminator is missing. A python or node body that opens a credential path
 * gets past this rule to the risk tier, like any script file would (design §12).
 */
function withoutDataHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const openers = [...line.matchAll(HEREDOC)].map((m) => ({ strip: m[1] === "-", delimiter: (m[2] ?? m[3] ?? m[4])! }));
    if (openers.length === 0) continue;
    let end = i;
    for (const { strip, delimiter } of openers) {
      do end++;
      while (end < lines.length && (strip ? lines[end]!.replace(/^\t+/, "") : lines[end]) !== delimiter);
      if (end >= lines.length) return command;
    }
    const shellReads = simpleCommands(line).some((words) => words.some((w) => SHELL_PROGRAMS.has(programName(w))));
    if (shellReads) kept.push(...lines.slice(i + 1, end + 1));
    i = end;
  }
  return kept.join("\n");
}

/** Credentials are never reachable through a rule's allow: the user decides. */
const credentialPaths: Rule = {
  name: "credential-paths",
  match(call, ctx) {
    const hits = (text: string) => CREDENTIAL_PATH.test(ownWorktreeRelative(text, ctx.workdir));
    const command = commandOf(call);
    if (command !== null) return hits(unquote(withoutDataHeredocs(command))) ? "defer" : null;
    if (FILE_TOOLS.has(call.tool)) return pathArgs(call).some(hits) ? "defer" : null;
    return null;
  },
};

const NETWORK_PROGRAMS = new Set(["curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "telnet", "npx", "bunx"]);
const INSTALLERS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add"]),
  bun: new Set(["install", "i", "add"]),
  pnpm: new Set(["install", "i", "add", "dlx"]),
  yarn: new Set(["install", "add", "dlx"]),
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
};

/** Content from outside the user may be steering the session: no fetching or installing without the user. */
const networkWhenTainted = bashRule("network-when-tainted", (command, ctx) => {
  if (!ctx.tainted) return null;
  const reaches = simpleCommands(command).some((words) =>
    words.some((w, i) => {
      const program = programName(w);
      return NETWORK_PROGRAMS.has(program) || (INSTALLERS[program]?.has(words[i + 1] ?? "") ?? false);
    }),
  );
  return reaches ? "defer" : null;
});

const READ_ONLY_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "pwd"]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch"]);
/** `git branch` flags that only list branches. */
export const BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-l", "--list", "--show-current", "--no-color"]);
/** No operators, substitution, expansion, globbing or redirection: what runs is what is written. */
const PLAIN_COMMAND = /^[\w \t./:@%+=,'"-]+$/;

const readOnlyCommands = bashRule("read-only-commands", (command) => {
  if (!PLAIN_COMMAND.test(command)) return null;
  const [program, sub, ...rest] = unquote(command).trim().split(/[ \t]+/);
  if (READ_ONLY_PROGRAMS.has(program!)) return "allow";
  if (program !== "git" || !READ_ONLY_GIT.has(sub ?? "")) return null;
  const args = rest;
  if (sub === "branch") return args.every((a) => BRANCH_LIST_FLAGS.has(a)) ? "allow" : null;
  return args.some((a) => a.startsWith("--output") || a === "--ext-diff") ? null : "allow";
});

/** The built-in rules for `bash` and the file tools, blocks first, then deferrals, then the read-only allow list. */
export const defaultRules: Rule[] = [
  noSudo,
  noForcePush,
  noGitConfig,
  noGitRemoteChange,
  noPipeToShell,
  noRmRoot,
  credentialPaths,
  networkWhenTainted,
  readOnlyCommands,
];
