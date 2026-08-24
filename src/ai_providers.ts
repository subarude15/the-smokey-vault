export type AiProviderConfig = {
  provider: string;
  key: string;
  baseUrl: string;
  model: string;
};

type Env = Record<string, string | undefined>;

/** Tried in this order when the configured provider cannot answer. */
export const AI_FAILOVER_ORDER = ["gemini", "openai", "openrouter", "anthropic"] as const;

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY"
};

export function defaultAiBaseUrl(provider: string, env: Env = process.env) {
  if (provider === "ollama") return env.OLLAMA_HOST || "http://host.docker.internal:11434";
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com/v1";
}

export function defaultAiModel(provider: string) {
  if (provider === "ollama") return "llama3.2-vision";
  if (provider === "anthropic") return "claude-sonnet-4-20250514";
  if (provider === "gemini") return "gemini-3.6-flash";
  // Free, 1M context, and accepts images, so vision label reads survive a failover.
  if (provider === "openrouter") return "stealth/ox-alpha";
  return "gpt-4o-mini";
}

/** Google retires Flash aliases without notice. A stale AI_MODEL should not take the mixologist down. */
const RETIRED_GEMINI_MODELS = new Set([
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.5-flash",
  "gemini-2.5-flash-latest"
]);

export function resolveAiModel(provider: string, model: string) {
  const id = model.replace(/^models\//, "").trim();
  if (provider === "gemini" && (!id || RETIRED_GEMINI_MODELS.has(id))) return defaultAiModel("gemini");
  return id || defaultAiModel(provider);
}

/**
 * Rate limits, timeouts, and upstream faults are worth asking someone else about.
 * A rejected key or a malformed request would fail the same way everywhere, so those
 * surface immediately instead of burning through every provider.
 *
 * 404 counts as retryable because providers retire model names on their own schedule.
 * A model that vanished here may well exist at the next provider, and stalling the whole
 * chain on a rename is worse than spending one extra request to find out.
 */
export function isRetryableAiStatus(status: number) {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

/**
 * The configured provider first, then every other provider holding an environment key.
 * Fallbacks deliberately use their own default model and endpoint: AI_MODEL and
 * AI_BASE_URL describe the primary provider, and handing a Gemini model name to OpenAI
 * would just fail a second time.
 */
export function buildAiFailoverChain(primary: AiProviderConfig, env: Env = process.env): AiProviderConfig[] {
  const chain = [primary];
  for (const provider of AI_FAILOVER_ORDER) {
    if (provider === primary.provider) continue;
    const key = env[ENV_KEY_BY_PROVIDER[provider]]?.trim();
    if (!key) continue;
    chain.push({ provider, key, baseUrl: defaultAiBaseUrl(provider, env), model: defaultAiModel(provider) });
  }
  return chain;
}
