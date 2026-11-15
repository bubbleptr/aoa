import type { Decision } from "./types.ts";

export type Risk = "low" | "medium" | "high";

/** What the policy sees of a call. Nothing the model says about its own safety is part of it (spec §6.2). */
export type ToolCall = { tool: string; args: unknown };

export type PolicyContext = {
  /** The session has taken content from someone other than the user (design §6). */
  tainted: boolean;
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

const commandOf = (call: ToolCall): string | null => {
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

function gitInvocations(command: string): GitInvocation[] {
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

/** Credentials are never reachable through a rule's allow: the user decides. */
const credentialPaths: Rule = {
  name: "credential-paths",
  match(call) {
    const command = commandOf(call);
    if (command !== null) return CREDENTIAL_PATH.test(unquote(command)) ? "defer" : null;
    if (FILE_TOOLS.has(call.tool)) return pathArgs(call).some((p) => CREDENTIAL_PATH.test(p)) ? "defer" : null;
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
const BRANCH_LIST_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-l", "--list", "--show-current", "--no-color"]);
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
