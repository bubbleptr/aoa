import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ModelConfig = { provider: string; apiKey?: string; providers?: Provider[] };

export async function createModelRuntime(config: ModelConfig): Promise<ModelRuntime> {
  // In-memory credentials and no models.json: nothing is read from or written to the user's ~/.pi.
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  for (const p of config.providers ?? []) runtime.registerNativeProvider(p);
  if (config.apiKey) await runtime.setRuntimeApiKey(config.provider, config.apiKey);
  return runtime;
}

/** The error with the API key cut out of its message; the same error when there is nothing to hide, so its class survives. */
export function redact(err: unknown, apiKey: string | undefined): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (apiKey && message.includes(apiKey)) return new Error(message.split(apiKey).join("[redacted]"));
  return err;
}
