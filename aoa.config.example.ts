// Copy to aoa.config.ts and fill in. Secrets stay out of this file: the model API key is read from the
// environment variable named in apiKeyEnv, and the GitHub App key from privateKeyPath.
import { defineAgent } from "./apps/aoa/src/config.ts";

export default defineAgent({
  dataDir: "~/.aoa",
  repo: { path: "~/code/your-repo", base: "main" },
  model: { provider: "anthropic", modelId: "your-model-id", apiKeyEnv: "ANTHROPIC_API_KEY" },
  classifier: { provider: "anthropic", modelId: "your-small-model-id", apiKeyEnv: "ANTHROPIC_API_KEY" },
  github: {
    owner: "your-github-user-or-org",
    repo: "your-repo",
    label: "aoa",
    userLogin: "your-github-login",
    botLogin: "your-app-slug[bot]",
    appId: 123456,
    installationId: 12345678,
    privateKeyPath: "~/.aoa/github-app.pem",
  },
});
