import { getSetting } from "./db.js";
import {
  type AiProviderConfig,
  AI_FAILOVER_ORDER,
  defaultAiBaseUrl,
  defaultAiModel,
  resolveAiModel,
  isRetryableAiStatus,
  buildAiFailoverChain
} from "./ai_providers.js";
import { AI_TIMEOUT_MS } from "./speakeasy-shared.js";

export class AiRequestError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly retryable = false) {
    super(message);
  }
}

export function resolveAiConfig() {
  const providerFromKey = process.env.GEMINI_API_KEY ? "gemini" : process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "";
  const environmentProvider = process.env.AI_PROVIDER?.trim().toLowerCase() || providerFromKey || (process.env.AI_API_KEY ? "openai" : "");
  const provider = environmentProvider || getSetting("aiProvider")?.toLowerCase() || "ollama";
  const environmentKey = process.env.AI_API_KEY ||
    (provider === "openrouter" ? process.env.OPENROUTER_API_KEY : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY) || "";
  const key = environmentKey || getSetting("aiApiKey") || "";
  const defaultBaseUrl = defaultAiBaseUrl(provider);
  const environmentBaseUrl = process.env.AI_BASE_URL?.trim() || "";
  const baseUrl = (environmentBaseUrl || defaultBaseUrl).replace(/\/$/, "");
  const defaultModel = defaultAiModel(provider);
  const environmentModel = process.env.AI_MODEL?.trim() || "";
  const model = resolveAiModel(provider, environmentModel || getSetting("aiModel") || defaultModel);
  const fromEnvironment = Boolean(environmentProvider || environmentKey || environmentBaseUrl || environmentModel || process.env.OLLAMA_HOST);
  return { provider, key, baseUrl, model, fromEnvironment, keyFromEnvironment: Boolean(environmentKey) };
}

export function endpointForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

export async function aiFetch(provider: string, url: string, init: RequestInit, timeoutMs = AI_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const cause = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String((error.cause as { code: unknown }).code)
      : "";
    const endpoint = endpointForLog(url);
    console.error(
      JSON.stringify({ msg: timedOut ? "AI provider timed out" : "AI provider could not be reached", provider, endpoint, cause, reason: error instanceof Error ? error.message : String(error) })
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

export async function requestAi({ provider, key, baseUrl, model }: AiProviderConfig, prompt: string, image?: string, timeoutMs = AI_TIMEOUT_MS): Promise<string> {
  if (provider === "anthropic") {
    const content: unknown[] = [{ type: "text", text: prompt }];
    if (image) content.unshift({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
    const response = await aiFetch(provider, `${baseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content }] }) }, timeoutMs);
    const data = await response.json() as { content?: Array<{ text: string }>; error?: { message?: string } };
    if (!response.ok) {
      console.error(JSON.stringify({ msg: "AI upstream request failed", provider, status: response.status, payload: data }));
      const message = response.status === 401 ? "Your AI API key is invalid. Check AI_API_KEY in the server .env." : data.error?.message ?? "Anthropic could not generate a recipe.";
      throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
    }
    return data.content?.[0]?.text ?? "";
  }
  if (provider === "gemini") {
    const parts: unknown[] = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
    const response = await aiFetch(provider, `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }] })
    }, timeoutMs);
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      console.error(JSON.stringify({ msg: "AI upstream request failed", provider, status: response.status, payload: data }));
      const message = response.status === 400 || response.status === 401 || response.status === 403
        ? "Your Gemini API key was rejected. Check AI_API_KEY or GEMINI_API_KEY in the server .env."
        : data.error?.message ?? "Gemini could not generate a recipe.";
      throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
    }
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  }
  const isOllama = provider === "ollama";
  const response = await aiFetch(provider, `${baseUrl}${isOllama ? "/api/chat" : "/chat/completions"}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(isOllama
      ? { model, stream: false, messages: [{ role: "user", content: prompt, ...(image ? { images: [image] } : {}) }] }
      : { model, messages: [{ role: "user", content: image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] : prompt }] })
  }, timeoutMs);
  const data = await response.json() as { message?: { content: string }; choices?: Array<{ message: { content: string } }>; error?: unknown };
  if (!response.ok) {
    console.error(JSON.stringify({ msg: "AI upstream request failed", provider, status: response.status, payload: data }));
    const providerMessage = typeof data.error === "object" && data.error && "message" in data.error ? String((data.error as { message: unknown }).message) : "";
    const message = response.status === 401 ? "Your AI API key is invalid. Check AI_API_KEY in the server .env." : providerMessage || `${provider} could not generate a recipe.`;
    throw new AiRequestError(message, response.status, isRetryableAiStatus(response.status));
  }
  return data.message?.content ?? data.choices?.[0]?.message.content ?? "";
}

export async function callLlm(prompt: string, image?: string, timeoutMs = AI_TIMEOUT_MS) {
  const primary = resolveAiConfig();
  if (primary.provider !== "ollama" && !primary.key) {
    throw new AiRequestError("Set AI_API_KEY in the server .env to read labels and mix drinks.", 400);
  }
  const chain = buildAiFailoverChain(primary, process.env);
  let lastError: unknown = new AiRequestError("No AI provider is configured.", 400);
  for (const [index, config] of chain.entries()) {
    try {
      return await requestAi(config, prompt, image, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AiRequestError ? error.retryable : true;
      const next = chain[index + 1];
      if (!retryable || !next) break;
      console.warn(JSON.stringify({
        msg: "Failing over AI request",
        provider: config.provider,
        status: error instanceof AiRequestError ? error.statusCode : 0,
        reason: error instanceof Error ? error.message : String(error),
        failingOverTo: next.provider,
        model: next.model
      }));
    }
  }
  throw lastError;
}
