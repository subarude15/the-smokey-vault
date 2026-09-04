/**
 * Shared Ollama endpoint + vision-model resolution for enrichment health
 * and product-image verification. Keeps callers on one precedence chain.
 */

export const DEFAULT_OLLAMA_BASE_URL = "http://192.168.1.184:11434";
export const DEFAULT_OLLAMA_VISION_MODEL = "llama3.2-vision";

function trimEnv(value: string | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Resolve Ollama daemon base URL (no /api/chat suffix).
 * Precedence: OLLAMA_CHAT_URL → SMOKEY_OLLAMA_CHAT_URL →
 * OLLAMA_HOST → SMOKEY_OLLAMA_HOST → production fallback.
 */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const chat = trimEnv(env.OLLAMA_CHAT_URL ?? env.SMOKEY_OLLAMA_CHAT_URL);
  if (chat) {
    return chat.replace(/\/api\/chat\/?$/i, "").replace(/\/$/, "") || chat;
  }
  const host = trimEnv(env.OLLAMA_HOST ?? env.SMOKEY_OLLAMA_HOST);
  if (host) return host.replace(/\/$/, "");
  return DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Resolve Ollama /api/chat URL for enrichment callers.
 * Exact OLLAMA_CHAT_URL / SMOKEY_OLLAMA_CHAT_URL wins; otherwise base + /api/chat.
 */
export function ollamaChatUrl(env: NodeJS.ProcessEnv = process.env): string {
  const chat = trimEnv(env.OLLAMA_CHAT_URL ?? env.SMOKEY_OLLAMA_CHAT_URL);
  if (chat) return chat.replace(/\/$/, "");
  return `${ollamaBaseUrl(env)}/api/chat`;
}

/**
 * Vision model for product-image verification only (not AI_MODEL / label reading).
 * Precedence: OLLAMA_VISION_MODEL → SMOKEY_OLLAMA_VISION_MODEL → llama3.2-vision.
 */
export function ollamaVisionModel(env: NodeJS.ProcessEnv = process.env): string {
  const model = trimEnv(env.OLLAMA_VISION_MODEL ?? env.SMOKEY_OLLAMA_VISION_MODEL);
  return model || DEFAULT_OLLAMA_VISION_MODEL;
}
