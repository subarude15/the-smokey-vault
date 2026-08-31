/**
 * Keeper-facing enrichment dependency health (SearXNG + Ollama).
 * Observability only — does not change queue/retry/enrichment behavior.
 */
import {
  isWebSearchError,
  probeSearxngConnectivity,
  safeHostFromUrl,
  searxngSafeHost
} from "../web-search.js";

export type ServiceHealthStatus = "connected" | "unreachable" | "degraded";

export type ServiceHealthResult = {
  status: ServiceHealthStatus;
  host: string;
  latencyMs: number | null;
  error: string | null;
};

export type EnrichmentHealthReport = {
  searxng: ServiceHealthResult;
  ollama: ServiceHealthResult;
  checkedAt: string;
};

export type EnrichmentHealthDeps = {
  fetch?: typeof fetch;
  probeSearxng?: typeof probeSearxngConnectivity;
  ollamaBaseUrl?: string;
};

/** Resolve Ollama base URL from the same env family enrichment extractors use. */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const chat = String(
    env.OLLAMA_CHAT_URL ?? env.SMOKEY_OLLAMA_CHAT_URL ?? ""
  ).trim();
  if (chat) {
    return chat.replace(/\/api\/chat\/?$/i, "").replace(/\/$/, "") || chat;
  }
  const host = String(env.OLLAMA_HOST ?? env.SMOKEY_OLLAMA_HOST ?? "").trim();
  if (host) return host.replace(/\/$/, "");
  return "http://192.168.1.184:11434";
}

export function ollamaSafeHost(env: NodeJS.ProcessEnv = process.env): string {
  return safeHostFromUrl(ollamaBaseUrl(env));
}

function friendlySearxngError(error: unknown): { status: ServiceHealthStatus; error: string } {
  if (isWebSearchError(error)) {
    if (error.code === "http_error") {
      const statusCode = error.httpStatus ?? 0;
      if (statusCode >= 500) {
        return { status: "unreachable", error: `HTTP ${statusCode}` };
      }
      return { status: "degraded", error: `HTTP ${statusCode}` };
    }
    if (error.code === "invalid_json") {
      return { status: "degraded", error: "Malformed response" };
    }
    if (error.code === "timeout") {
      return { status: "unreachable", error: "Connection timed out" };
    }
    return { status: "unreachable", error: "Connection failed" };
  }
  const message = error instanceof Error ? error.message : "Connection failed";
  if (/timeout|aborted/i.test(message)) {
    return { status: "unreachable", error: "Connection timed out" };
  }
  return { status: "unreachable", error: "Connection failed" };
}

export async function checkSearxngHealth(
  deps: EnrichmentHealthDeps = {}
): Promise<ServiceHealthResult> {
  const host = searxngSafeHost();
  const probe = deps.probeSearxng ?? probeSearxngConnectivity;
  try {
    const result = await probe({
      fetch: deps.fetch,
      timeoutMs: 3_000
    });
    return {
      status: "connected",
      host,
      latencyMs: result.latencyMs,
      error: null
    };
  } catch (error) {
    const mapped = friendlySearxngError(error);
    return {
      status: mapped.status,
      host,
      latencyMs: null,
      error: mapped.error
    };
  }
}

/**
 * Lightweight Ollama check: GET /api/tags (no generation).
 * Connected when the daemon answers with a tags payload.
 */
export async function checkOllamaHealth(
  deps: EnrichmentHealthDeps = {}
): Promise<ServiceHealthResult> {
  const base = deps.ollamaBaseUrl ?? ollamaBaseUrl();
  const host = safeHostFromUrl(base);
  const fetchFn = deps.fetch ?? fetch;
  const started = Date.now();
  try {
    const response = await fetchFn(`${base.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) {
      return {
        status: response.status >= 500 ? "unreachable" : "degraded",
        host,
        latencyMs: null,
        error: `HTTP ${response.status}`
      };
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        status: "degraded",
        host,
        latencyMs: null,
        error: "Malformed response"
      };
    }
    if (!data || typeof data !== "object") {
      return {
        status: "degraded",
        host,
        latencyMs: null,
        error: "Malformed response"
      };
    }
    const models = (data as { models?: unknown }).models;
    if (!Array.isArray(models) || models.length === 0) {
      return {
        status: "degraded",
        host,
        latencyMs: null,
        error: "No models available"
      };
    }
    return {
      status: "connected",
      host,
      latencyMs: Date.now() - started,
      error: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    const timedOut =
      (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      || /timeout|aborted/i.test(message);
    return {
      status: "unreachable",
      host,
      latencyMs: null,
      error: timedOut ? "Connection timed out" : "Connection failed"
    };
  }
}

export async function checkEnrichmentHealth(
  deps: EnrichmentHealthDeps = {}
): Promise<EnrichmentHealthReport> {
  const [searxng, ollama] = await Promise.all([
    checkSearxngHealth(deps),
    checkOllamaHealth(deps)
  ]);
  return {
    searxng,
    ollama,
    checkedAt: new Date().toISOString()
  };
}
