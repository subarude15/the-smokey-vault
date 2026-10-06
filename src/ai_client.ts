import {
  buildAiFailoverChain,
  defaultAiBaseUrl,
  defaultAiModel,
  isRetryableAiStatus,
  providerModelFromEnv,
  resolveAiModel,
  type AiProviderConfig
} from "./ai_providers.js";
import { AI_TIMEOUT_MS } from "./speakeasy-shared.js";

export class AiRequestError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly retryable = false) {
    super(message);
    this.name = "AiRequestError";
  }
}

export type AiSettingsSource = {
  aiProvider?: string | null;
  aiApiKey?: string | null;
  aiModel?: string | null;
};

export type AiLogger = {
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
};

export type AiRuntimeStatus = {
  primary: { provider: string; model: string; baseUrl: string; configured: boolean };
  fallback: { provider: string; model: string; baseUrl: string } | null;
  /** Explicit AI_FALLBACK_PROVIDER when set; otherwise null (primary-only). */
  fallbackProviderEnv: string | null;
};

/**
 * Optional structured-output check. Throw when the text is unusable for the caller.
 * Feature-specific schemas stay in the caller/parser — ai_client only treats a throw
 * as a retryable model-output failure so an opt-in fallback can try next.
 */
export type AiOutputValidate = (text: string) => void;

type Env = Record<string, string | undefined>;

const noopLogger: AiLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function logLine(logger: AiLogger, level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) {
  if (fields) logger[level](fields, message);
  else logger[level](message);
}

export function maskSecret(value: string) {
  if (!value) return "not set";
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** Gemini carries its key in the query string, so only the endpoint is ever logged. */
export function endpointForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid url";
  }
}

export function resolveAiConfig(env: Env = process.env, settings: AiSettingsSource = {}) {
  const providerFromKey = env.GEMINI_API_KEY
    ? "gemini"
    : env.OPENROUTER_API_KEY
      ? "openrouter"
      : env.ANTHROPIC_API_KEY
        ? "anthropic"
        : env.OPENAI_API_KEY
          ? "openai"
          : "";
  const environmentProvider =
    env.AI_PROVIDER?.trim().toLowerCase() || providerFromKey || (env.AI_API_KEY ? "openai" : "");
  const provider = environmentProvider || settings.aiProvider?.toLowerCase() || "ollama";
  const environmentKey =
    env.AI_API_KEY ||
    (provider === "openrouter"
      ? env.OPENROUTER_API_KEY
      : provider === "anthropic"
        ? env.ANTHROPIC_API_KEY
        : provider === "gemini"
          ? env.GEMINI_API_KEY
          : env.OPENAI_API_KEY) ||
    "";
  const key = environmentKey || settings.aiApiKey || "";
  const defaultBaseUrl = defaultAiBaseUrl(provider, env);
  const environmentBaseUrl = env.AI_BASE_URL?.trim() || "";
  // A stored aiBaseUrl is deliberately ignored: nothing writes it, no screen edits it, and
  // the settings API strips it, so a stale row could only misroute a working provider.
  // AI_BASE_URL is the supported override for a proxy or self-hosted gateway.
  const baseUrl = (environmentBaseUrl || defaultBaseUrl).replace(/\/$/, "");
  const defaultModel = defaultAiModel(provider);
  const environmentModel =
    env.AI_MODEL?.trim() || providerModelFromEnv(provider, env) || "";
  const model = resolveAiModel(provider, environmentModel || settings.aiModel || defaultModel);
  const fromEnvironment = Boolean(
    environmentProvider ||
      environmentKey ||
      environmentBaseUrl ||
      environmentModel ||
      env.OLLAMA_HOST ||
      env.OLLAMA_BASE_URL ||
      env.OLLAMA_MODEL
  );
  return {
    provider,
    key,
    baseUrl,
    model,
    fromEnvironment,
    keyFromEnvironment: Boolean(environmentKey)
  };
}

export function describeAiRuntime(env: Env = process.env, settings: AiSettingsSource = {}): AiRuntimeStatus {
  const primary = resolveAiConfig(env, settings);
  const chain = buildAiFailoverChain(primary, env);
  const fallback = chain[1] ?? null;
  const fallbackProviderEnv = env.AI_FALLBACK_PROVIDER?.trim().toLowerCase() || null;
  return {
    primary: {
      provider: primary.provider,
      model: primary.model,
      baseUrl: primary.baseUrl,
      configured: primary.provider === "ollama" || Boolean(primary.key)
    },
    fallback: fallback
      ? { provider: fallback.provider, model: fallback.model, baseUrl: fallback.baseUrl }
      : null,
    fallbackProviderEnv
  };
}

/**
 * Lightweight Ollama reachability for AI status. Uses AI OLLAMA_HOST / alias — not Gemini.
 * Returns model availability when /api/tags lists the configured model (prefix match).
 */
export async function probeOllamaAiHealth(options: {
  baseUrl: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} ): Promise<{
  reachable: boolean;
  modelAvailable: boolean | null;
  host: string;
  error: string | null;
}> {
  const fetchFn = options.fetchFn ?? fetch;
  let host = options.baseUrl;
  try {
    const parsed = new URL(options.baseUrl);
    host = parsed.host;
  } catch {
    /* keep raw */
  }
  try {
    const response = await fetchFn(`${options.baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000)
    });
    if (!response.ok) {
      return { reachable: false, modelAvailable: null, host, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (data.models ?? [])
      .map((entry) => String(entry.name || entry.model || "").trim())
      .filter(Boolean);
    if (!options.model) {
      return { reachable: names.length > 0, modelAvailable: null, host, error: names.length ? null : "No models available" };
    }
    const wanted = options.model.toLowerCase();
    const modelAvailable = names.some(
      (name) => name.toLowerCase() === wanted || name.toLowerCase().startsWith(`${wanted}:`)
    );
    return {
      reachable: true,
      modelAvailable,
      host,
      error: modelAvailable ? null : `Model ${options.model} not listed`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut =
      (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) ||
      /timeout|aborted/i.test(message);
    return {
      reachable: false,
      modelAvailable: null,
      host,
      error: timedOut ? "Connection timed out" : "Connection failed"
    };
  }
}

/** Network faults and timeouts arrive as thrown errors, not statuses; both are retryable. */
export async function aiFetch(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs = AI_TIMEOUT_MS,
  logger: AiLogger = noopLogger
) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const cause =
      error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
        ? String((error.cause as { code: unknown }).code)
        : "";
    const endpoint = endpointForLog(url);
    logLine(
      logger,
      "error",
      timedOut ? `[AI] provider=${provider} timeout` : `[AI] provider=${provider} unreachable`,
      { provider, endpoint, cause, reason: error instanceof Error ? error.message : String(error) }
    );
    throw new AiRequestError(
      timedOut
        ? `${provider} timed out after ${timeoutMs / 1000}s.`
        : `${provider} could not be reached at ${endpoint}${cause ? ` (${cause})` : ""}.`,
      timedOut ? 504 : 503,
      true
    );
  }
}

function ollamaMessages(prompt: string, image?: string, systemPrompt?: string) {
  const messages: Array<Record<string, unknown>> = [];
  if (systemPrompt?.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() });
  }
  messages.push({
    role: "user",
    content: prompt,
    ...(image ? { images: [image] } : {})
  });
  return messages;
}

export async function requestAi(
  { provider, key, baseUrl, model }: AiProviderConfig,
  prompt: string,
  image?: string,
  timeoutMs = AI_TIMEOUT_MS,
  maxTokens?: number,
  logger: AiLogger = noopLogger,
  systemPrompt?: string
): Promise<string> {
  if (provider === "anthropic") {
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
    const response = await aiFetch(
      provider,
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens ?? 1200,
          ...(systemPrompt?.trim() ? { system: systemPrompt.trim() } : {}),
          messages: [{ role: "user", content }]
        })
      },
      timeoutMs,
      logger
    );
    const data = (await response.json()) as { content?: Array<{ text: string }>; error?: { message?: string } };
    if (!response.ok) {
      logLine(logger, "error", `[AI] provider=${provider} fail status=${response.status}`, {
        provider,
        status: response.status
      });
      const message =
        response.status === 401
          ? "Your AI API key is invalid. Check AI_API_KEY in the server .env."
          : data.error?.message ?? "Anthropic could not generate a recipe.";
      throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
    }
    return requireNonEmptyAiText(provider, data.content?.[0]?.text ?? "");
  }
  if (provider === "gemini") {
    const parts: unknown[] = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
    const response = await aiFetch(
      provider,
      `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          ...(maxTokens ? { generationConfig: { maxOutputTokens: maxTokens } } : {}),
          ...(systemPrompt?.trim()
            ? { systemInstruction: { parts: [{ text: systemPrompt.trim() }] } }
            : {})
        })
      },
      timeoutMs,
      logger
    );
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      logLine(logger, "error", `[AI] provider=${provider} fail status=${response.status}`, {
        provider,
        status: response.status
      });
      const message =
        response.status === 400 || response.status === 401 || response.status === 403
          ? "Your Gemini API key was rejected. Check AI_API_KEY or GEMINI_API_KEY in the server .env."
          : data.error?.message ?? "Gemini could not generate a recipe.";
      throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
    }
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return requireNonEmptyAiText(provider, text);
  }
  const isOllama = provider === "ollama";
  const response = await aiFetch(
    provider,
    `${baseUrl}${isOllama ? "/api/chat" : "/chat/completions"}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(
        isOllama
          ? {
              model,
              stream: false,
              messages: ollamaMessages(prompt, image, systemPrompt)
            }
          : {
              model,
              ...(maxTokens ? { max_tokens: maxTokens } : {}),
              messages: [
                ...(systemPrompt?.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
                {
                  role: "user",
                  content: image
                    ? [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }
                      ]
                    : prompt
                }
              ]
            }
      )
    },
    timeoutMs,
    logger
  );
  const data = (await response.json()) as {
    message?: { content: string };
    choices?: Array<{ message: { content: string } }>;
    error?: unknown;
  };
  if (!response.ok) {
    logLine(logger, "error", `[AI] provider=${provider} fail status=${response.status}`, {
      provider,
      status: response.status
    });
    const providerMessage =
      typeof data.error === "object" && data.error && "message" in data.error
        ? String((data.error as { message: unknown }).message)
        : "";
    const message =
      response.status === 401
        ? "Your AI API key is invalid. Check AI_API_KEY in the server .env."
        : providerMessage || `${provider} could not generate a recipe.`;
    throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
  }
  return requireNonEmptyAiText(provider, data.message?.content ?? data.choices?.[0]?.message.content ?? "");
}

/** Empty / whitespace-only answers are retryable so an explicit fallback can try next. */
function requireNonEmptyAiText(provider: string, text: string) {
  if (!text.trim()) {
    throw new AiRequestError(`${provider} returned an empty response.`, 502, true);
  }
  return text;
}

function applyOutputValidate(provider: string, text: string, validate?: AiOutputValidate) {
  if (!validate) return text;
  try {
    validate(text);
    return text;
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : `${provider} returned unusable structured output.`;
    throw new AiRequestError(message, 502, true);
  }
}

export type CallLlmOptions = {
  prompt: string;
  image?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * Caller-owned structural check (e.g. existing JSON parsers). Throw when unusable.
   * On throw, callLlm treats the attempt as retryable and may use AI_FALLBACK_PROVIDER.
   */
  validate?: AiOutputValidate;
  env?: Env;
  settings?: AiSettingsSource;
  logger?: AiLogger;
  /** Override request transport (tests). */
  request?: typeof requestAi;
};

/**
 * Asks the configured primary provider. When AI_FALLBACK_PROVIDER is set, retries that
 * one provider after a retryable failure (network, timeout, 5xx/404/429, empty text, or
 * optional validate throw). Blank AI_FALLBACK_PROVIDER → primary only.
 */
export async function callLlm(
  promptOrOptions: string | CallLlmOptions,
  image?: string,
  timeoutMs = AI_TIMEOUT_MS,
  maxTokens?: number,
  deps: {
    env?: Env;
    settings?: AiSettingsSource;
    logger?: AiLogger;
    request?: typeof requestAi;
    validate?: AiOutputValidate;
  } = {}
) {
  const options: CallLlmOptions =
    typeof promptOrOptions === "string"
      ? { prompt: promptOrOptions, image, timeoutMs, maxTokens, ...deps }
      : { ...deps, ...promptOrOptions };
  const env = options.env ?? process.env;
  const settings = options.settings ?? {};
  const logger = options.logger ?? noopLogger;
  const request = options.request ?? requestAi;
  const primary = resolveAiConfig(env, settings);
  if (primary.provider !== "ollama" && !primary.key) {
    throw new AiRequestError("Set AI_API_KEY in the server .env to read labels and mix drinks.", 400);
  }
  const chain = buildAiFailoverChain(primary, env);
  logLine(logger, "info", `[AI] primary provider=${primary.provider} model=${primary.model}`, {
    provider: primary.provider,
    model: primary.model,
    fallbacks: chain.slice(1).map((config) => config.provider)
  });
  let lastError: unknown = new AiRequestError("No AI provider is configured.", 400);
  for (const [index, config] of chain.entries()) {
    try {
      const text = await request(
        config,
        options.prompt,
        options.image,
        options.timeoutMs ?? AI_TIMEOUT_MS,
        options.maxTokens,
        logger,
        options.systemPrompt
      );
      const validated = applyOutputValidate(config.provider, text, options.validate);
      logLine(
        logger,
        "info",
        `[AI] success provider=${config.provider}${index > 0 ? " via_fallback=true" : ""}`,
        { provider: config.provider, model: config.model, viaFallback: index > 0 }
      );
      return validated;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AiRequestError ? error.retryable : true;
      const next = chain[index + 1];
      logLine(
        logger,
        "warn",
        `[AI] fail provider=${config.provider}${next ? ` fallback=${next.provider}` : " no_fallback"}`,
        {
          provider: config.provider,
          status: error instanceof AiRequestError ? error.statusCode : 0,
          reason: error instanceof Error ? error.message : String(error),
          failingOverTo: next?.provider,
          model: next?.model
        }
      );
      if (!retryable || !next) break;
    }
  }
  throw lastError;
}
