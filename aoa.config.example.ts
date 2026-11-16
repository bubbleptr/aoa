// Copy to ~/.aoa/aoa.config.ts (used from any directory) or to aoa.config.ts in the directory you run aoa from,
// and fill in. Secrets stay out of this file: the model API key is read from the environment variable named in
// apiKeyEnv, and the GitHub App key (if you use GitHub) from privateKeyPath.
// The file's default export is a plain object, so it needs no import and can live outside this repository.
export default {
  dataDir: "~/.aoa",
  repo: { path: "~/code/your-repo", base: "main" },
  model: { provider: "anthropic", modelId: "your-model-id", apiKeyEnv: "ANTHROPIC_API_KEY" },
  // Required by `aoa serve`: it judges bash calls, which otherwise all wait for your approval.
  classifier: { provider: "anthropic", modelId: "your-small-model-id", apiKeyEnv: "ANTHROPIC_API_KEY" },
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
