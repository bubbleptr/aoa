// Copy to ~/.aoa/aoa.config.ts (used from any directory) or to aoa.config.ts in the directory you run aoa from,
// and fill in. Secrets stay out of this file: the model API key is read from the environment variable named in
// apiKeyEnv, and the GitHub App key (if you use GitHub) from privateKeyPath.
// The file's default export is a plain object, so it needs no import and can live outside this repository.
export default {
  dataDir: "~/.aoa",
  repo: { path: "~/code/your-repo", base: "main" },
  model: { provider: "deepseek", modelId: "deepseek-v4-pro", apiKeyEnv: "DEEPSEEK_API_KEY" },
  // Required by `aoa serve`: it judges bash calls, which otherwise all wait for your approval.
  classifier: { provider: "deepseek", modelId: "deepseek-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
  // Optional: score every classifier call with TypeSafe Jev without changing or delaying its decision (design §12).
  // shadowJudge: { provider: "typesafe", modelId: "jev-1.14.0", apiKeyEnv: "TYPESAFE_API_KEY" },
  // Optional, local mode only: more agents in the same serve. Each has its own inbox, worktrees and memory, and takes
  // model, classifier and risk from the top level unless it sets them. A review agent cannot edit files or change
  // git history; the implementing agents hand it their branch with send_to, and it sends its verdict back.
  // agents: {
  //   reviewer: { role: "review", instructions: "Focus on missing tests." },
  // },
  // Without a github block aoa runs in local mode. Add one to take tasks from issues and open pull requests:
  // github: {
  //   owner: "your-github-user-or-org",
  //   repo: "your-repo",
  //   label: "aoa",
  //   userLogin: "your-github-login",
  //   botLogin: "your-app-slug[bot]",
  //   appId: 123456,
  //   installationId: 12345678,
  //   privateKeyPath: "~/.aoa/github-app.pem",
  // },
};
