export type AiProviderConfig = {
  provider: string;
  key: string;
  baseUrl: string;
  model: string;
};

type Env = Record<string, string | undefined>;

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY"
};

export function defaultAiBaseUrl(provider: string, env: Env = process.env) {
  if (provider === "ollama") {
    // OLLAMA_HOST is the supported name; OLLAMA_BASE_URL is accepted as a compatibility alias.
    return env.OLLAMA_HOST || env.OLLAMA_BASE_URL || "http://host.docker.internal:11434";
  }
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com/v1";
}

export function defaultAiModel(provider: string) {
  if (provider === "ollama") return "gemma4";
  if (provider === "anthropic") return "claude-sonnet-4-20250514";
  if (provider === "gemini") return "gemini-3.6-flash";
  // Free, 1M context, and accepts images, so vision label reads survive a fallback.
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
 * Provider-specific model env aliases (used when AI_MODEL is blank).
 * OLLAMA_MODEL / GEMINI_MODEL never override AI_MODEL.
 */
export function providerModelFromEnv(provider: string, env: Env = process.env) {
  if (provider === "ollama") return env.OLLAMA_MODEL?.trim() || "";
  if (provider === "gemini") return env.GEMINI_MODEL?.trim() || "";
  return "";
}

/**
 * Rate limits, timeouts, and upstream faults are worth asking the configured fallback about.
 * A rejected key or a malformed request would fail the same way everywhere, so those
 * surface immediately instead of burning another provider.
 *
 * 404 counts as retryable because providers retire model names on their own schedule.
 */
export function isRetryableAiStatus(status: number) {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function keyForProvider(provider: string, env: Env) {
  const envName = ENV_KEY_BY_PROVIDER[provider];
  return envName ? env[envName]?.trim() || "" : "";
}

/**
 * Builds the provider attempt list for callLlm.
 *
 * Fallback is explicitly opt-in via AI_FALLBACK_PROVIDER:
 * - missing / blank / whitespace → primary only (API keys alone never add providers)
 * - set (e.g. gemini) → [primary, that one] when the fallback has a key (ollama needs none)
 *
 * Fallbacks use their own model and endpoint — never the primary's AI_MODEL / AI_BASE_URL.
 */
export function buildAiFailoverChain(primary: AiProviderConfig, env: Env = process.env): AiProviderConfig[] {
  const explicit = env.AI_FALLBACK_PROVIDER?.trim().toLowerCase() || "";
  if (!explicit || explicit === primary.provider) return [primary];

  const key = explicit === "ollama" ? "" : keyForProvider(explicit, env);
  if (explicit !== "ollama" && !key) return [primary];

  const model = resolveAiModel(explicit, providerModelFromEnv(explicit, env) || defaultAiModel(explicit));
  return [
    primary,
    { provider: explicit, key, baseUrl: defaultAiBaseUrl(explicit, env), model }
  ];
}
