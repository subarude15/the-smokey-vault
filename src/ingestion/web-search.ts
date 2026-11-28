/**
 * SearXNG JSON search used when catalogs miss a bottle.
 * Provider/network failures throw WebSearchError — never masquerade as empty results.
 */
export type WebSearchHit = {
  title: string;
  content: string;
  url: string;
};

export type WebSearchErrorCode =
  | "timeout"
  | "http_error"
  | "invalid_json"
  | "engines_failed"
  | "network"
  | "unreachable";

export type UnresponsiveEngine = [engine: string, reason: string];

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly provider = "searxng" as const;
  readonly httpStatus?: number;
  readonly unresponsiveEngines?: UnresponsiveEngine[];

  constructor(
    code: WebSearchErrorCode,
    message: string,
    httpStatus?: number,
    unresponsiveEngines?: UnresponsiveEngine[]
  ) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.unresponsiveEngines = unresponsiveEngines;
  }
}

type SearxResult = {
  title?: string;
  content?: string;
  url?: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  width?: number | string;
  height?: number | string;
};

type SearxSearchResponse = {
  results?: SearxResult[];
  unresponsive_engines?: unknown;
};

const SEARXNG_BACKOFF_THRESHOLD = 3;
const SEARXNG_BACKOFF_MS = 120_000;

let consecutiveEngineFailures = 0;
let searxngBackoffUntil = 0;

/** Reset in-memory SearXNG backoff state (intended for tests and recovery probes). */
export function resetSearxngSearchState(): void {
  consecutiveEngineFailures = 0;
  searxngBackoffUntil = 0;
}

export function searxngBackoffState(): {
  consecutiveEngineFailures: number;
  pausedUntil: number;
  paused: boolean;
} {
  const now = Date.now();
  return {
    consecutiveEngineFailures,
    pausedUntil: searxngBackoffUntil,
    paused: searxngBackoffUntil > now
  };
}

function parseUnresponsiveEngines(raw: unknown): UnresponsiveEngine[] {
  if (!Array.isArray(raw)) return [];
  const out: UnresponsiveEngine[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 1) {
      const engine = String(entry[0] ?? "").trim().slice(0, 48);
      const reason = String(entry[1] ?? "error").trim().slice(0, 80);
      if (engine) out.push([engine, reason || "error"]);
    } else if (typeof entry === "string" && entry.trim()) {
      out.push([entry.trim().slice(0, 48), "error"]);
    }
  }
  return out;
}

export function summarizeUnresponsiveEngines(engines: UnresponsiveEngine[]): string {
  if (!engines.length) return "";
  const sample = engines
    .slice(0, 3)
    .map(([name, reason]) => `${name}: ${reason}`)
    .join(", ");
  const extra = engines.length > 3 ? ` (+${engines.length - 3} more)` : "";
  return `${sample}${extra}`.slice(0, 180);
}

/** Prefer env; fall back to the historically configured local SearXNG endpoint. */
export function searxngSearchUrl(): string {
  const fromEnv = String(
    process.env.SEARXNG_URL
      ?? process.env.SMOKEY_SEARXNG_URL
      ?? process.env.SEARXNG_SEARCH_URL
      ?? ""
  ).trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "http://192.168.1.184:8888/search";
}

function braveSearchApiKey(): string {
  return String(
    process.env.BRAVE_SEARCH_API_KEY
      ?? process.env.SMOKEY_BRAVE_SEARCH_API_KEY
      ?? ""
  ).trim();
}

function classifyFetchError(error: unknown): WebSearchError {
  if (error instanceof WebSearchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (
    name === "TimeoutError"
    || name === "AbortError"
    || /timeout|aborted|AbortError/i.test(message)
  ) {
    return new WebSearchError("timeout", `SearXNG timeout: ${message}`);
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(message)) {
    return new WebSearchError("unreachable", `SearXNG unreachable: ${message}`);
  }
  return new WebSearchError("network", `SearXNG network error: ${message}`);
}

async function searxngFetch(query: string, extraParams: Record<string, string> = {}): Promise<SearxSearchResponse> {
  const q = query.trim();
  if (!q) return { results: [] };

  const now = Date.now();
  if (searxngBackoffUntil > now) {
    throw new WebSearchError(
      "engines_failed",
      "SearXNG search paused after repeated upstream engine failures"
    );
  }

  const params = new URLSearchParams({ q, format: "json", ...extraParams });
  const url = `${searxngSearchUrl()}?${params}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw classifyFetchError(error);
  }

  if (!response.ok) {
    throw new WebSearchError(
      "http_error",
      `SearXNG returned HTTP ${response.status}`,
      response.status
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new WebSearchError(
      "invalid_json",
      `SearXNG returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!data || typeof data !== "object") {
    throw new WebSearchError("invalid_json", "SearXNG JSON root was not an object");
  }

  const parsed = data as SearxSearchResponse;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const unresponsive = parseUnresponsiveEngines(parsed.unresponsive_engines);

  if (results.length === 0 && unresponsive.length > 0) {
    consecutiveEngineFailures += 1;
    if (consecutiveEngineFailures >= SEARXNG_BACKOFF_THRESHOLD) {
      searxngBackoffUntil = Date.now() + SEARXNG_BACKOFF_MS;
    }
    const detail = summarizeUnresponsiveEngines(unresponsive);
    throw new WebSearchError(
      "engines_failed",
      `SearXNG upstream engines failed (${detail})`,
      undefined,
      unresponsive
    );
  }

  consecutiveEngineFailures = 0;
  searxngBackoffUntil = 0;
  return parsed;
}

type BraveWebResponse = {
  web?: {
    results?: Array<{
      title?: string;
      description?: string;
      url?: string;
    }>;
  };
};

type BraveImageResponse = {
  results?: Array<{
    url?: string;
    properties?: {
      url?: string;
      width?: number | string;
      height?: number | string;
    };
    thumbnail?: {
      src?: string;
    };
  }>;
};

/** Optional fallback web search via Brave Search API when BRAVE_SEARCH_API_KEY is set. */
async function searchWebHitsFromBrave(query: string, limit: number, apiKey: string): Promise<WebSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const count = Math.min(20, Math.max(1, limit));
  const params = new URLSearchParams({ q, count: String(count) });
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Brave Search API returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as BraveWebResponse;
  const rows = Array.isArray(data?.web?.results) ? data.web.results : [];
  return rows
    .slice(0, Math.max(0, limit))
    .map((row) => {
      const title = String(row.title ?? "").trim();
      const content = String(row.description ?? "").trim();
      const url = String(row.url ?? "").trim();
      if (!title && !content) return null;
      return { title, content, url };
    })
    .filter((hit): hit is WebSearchHit => Boolean(hit));
}

/** Optional fallback image search via Brave Search API when BRAVE_SEARCH_API_KEY is set. */
async function searchImageHitsFromBrave(query: string, limit: number, apiKey: string): Promise<ImageSearchSeed[]> {
  const q = query.trim();
  if (!q) return [];
  const count = Math.min(20, Math.max(1, limit));
  const params = new URLSearchParams({ q, count: String(count) });
  const response = await fetch(`https://api.search.brave.com/res/v1/images/search?${params}`, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Brave Image Search API returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as BraveImageResponse;
  const rows = Array.isArray(data?.results) ? data.results : [];
  const out: ImageSearchSeed[] = [];
  for (const row of rows.slice(0, Math.max(0, limit))) {
    const imageUrl = String(row.properties?.url || row.thumbnail?.src || "").trim();
    const pageUrl = String(row.url || "").trim() || null;
    if (!imageUrl.startsWith("http")) continue;
    const width = row.properties?.width != null ? Number(row.properties.width) : null;
    const height = row.properties?.height != null ? Number(row.properties.height) : null;
    out.push({
      url: imageUrl,
      sourceUrl: pageUrl,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      mimeType: null
    });
  }
  return out;
}

export async function searchWebHits(query: string, limit = 5): Promise<WebSearchHit[]> {
  let data: SearxSearchResponse;
  try {
    data = await searxngFetch(query);
  } catch (error) {
    const braveKey = braveSearchApiKey();
    if (isWebSearchError(error) && braveKey) {
      try {
        return await searchWebHitsFromBrave(query, limit, braveKey);
      } catch {
        throw error;
      }
    }
    throw error;
  }
  const results = (data.results ?? []).slice(0, Math.max(0, limit));
  return results
    .map((result) => {
      const title = String(result.title ?? "").trim();
      const content = String(result.content ?? "").trim();
      const url = String(result.url ?? "").trim();
      if (!title && !content) return null;
      return { title, content, url };
    })
    .filter((hit): hit is WebSearchHit => Boolean(hit));
}

export async function searchWebSnippets(query: string, limit = 5): Promise<string> {
  const hits = await searchWebHits(query, limit);
  if (!hits.length) return "";
  return hits
    .map((hit, index) => {
      const title = hit.title.trim();
      const content = hit.content.trim();
      if (!title && !content) return "";
      return `${index + 1}. ${title}${title && content ? " — " : ""}${content}`;
    })
    .filter(Boolean)
    .join("\n");
}

export type ImageSearchSeed = {
  url: string;
  sourceUrl?: string | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
};

function isNonPhotoImageUrl(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  const pathOnly = lower.split(/[?#]/)[0] ?? lower;
  if (pathOnly.endsWith(".svg")) return true;
  if (
    lower.includes("/gh/devicons/")
    || lower.includes("simple-icons")
    || lower.includes("svgrepo.com")
  ) {
    return true;
  }
  return false;
}

/** SearXNG image-category search; throws WebSearchError on provider failure. */
export async function searchImageHitsFromSearx(query: string, limit = 8): Promise<ImageSearchSeed[]> {
  let data: SearxSearchResponse;
  try {
    data = await searxngFetch(query, { categories: "images" });
  } catch (error) {
    const braveKey = braveSearchApiKey();
    if (isWebSearchError(error) && braveKey) {
      try {
        return await searchImageHitsFromBrave(query, limit, braveKey);
      } catch {
        throw error;
      }
    }
    throw error;
  }
  const out: ImageSearchSeed[] = [];
  const cap = Math.max(0, limit);
  const scanLimit = Math.max(cap * 3, 24);
  for (const row of (data.results ?? []).slice(0, scanLimit)) {
    if (out.length >= cap) break;
    const imageUrl = String(row.img_src || row.thumbnail_src || row.thumbnail || row.url || "").trim();
    const pageUrl = String(row.url || "").trim() || null;
    if (!imageUrl.startsWith("http")) continue;
    if (isNonPhotoImageUrl(imageUrl)) continue;
    const width = row.width != null ? Number(row.width) : null;
    const height = row.height != null ? Number(row.height) : null;
    out.push({
      url: imageUrl,
      sourceUrl: pageUrl,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      mimeType: null
    });
  }
  if (out.length === 0 && cap > 0) {
    const braveKey = braveSearchApiKey();
    if (braveKey) {
      try {
        return await searchImageHitsFromBrave(query, limit, braveKey);
      } catch {
        return [];
      }
    }
  }
  return out;
}

export function isWebSearchError(error: unknown): error is WebSearchError {
  return error instanceof WebSearchError;
}

/** Host:port only — never userinfo, path, or query (may contain secrets). */
export function safeHostFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) return `${parsed.hostname}:${parsed.port}`;
    return parsed.hostname || "unknown";
  } catch {
    // Last resort: strip credentials-looking segments without throwing.
    const cleaned = String(rawUrl ?? "")
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/^[^/@]+@/, "")
      .split(/[/?#]/)[0]
      ?.trim();
    return cleaned || "unknown";
  }
}

export function searxngSafeHost(): string {
  return safeHostFromUrl(searxngSearchUrl());
}

export type SearxngProbeResult = {
  latencyMs: number;
  httpStatus: number;
  resultCount: number;
  unresponsiveEngines: UnresponsiveEngine[];
};

/**
 * Lightweight functional SearXNG connectivity probe.
 * Uses a benign deterministic query (not ".") so upstream engine failures or
 * zero-result stalls surface as degraded instead of falsely reporting connected.
 * Throws WebSearchError on network/HTTP/JSON failure (same classification as enrichment search).
 */
export async function probeSearxngConnectivity(options?: {
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<SearxngProbeResult> {
  const fetchFn = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 3_000;
  const params = new URLSearchParams({ q: "wikipedia", format: "json" });
  const url = `${searxngSearchUrl()}?${params}`;
  const started = Date.now();

  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw classifyFetchError(error);
  }

  if (!response.ok) {
    throw new WebSearchError(
      "http_error",
      `SearXNG returned HTTP ${response.status}`,
      response.status
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new WebSearchError(
      "invalid_json",
      `SearXNG returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!data || typeof data !== "object") {
    throw new WebSearchError("invalid_json", "SearXNG JSON root was not an object");
  }

  const parsed = data as SearxSearchResponse;
  const resultCount = Array.isArray(parsed.results) ? parsed.results.length : 0;
  const unresponsiveEngines = parseUnresponsiveEngines(parsed.unresponsive_engines);

  if (resultCount > 0) {
    resetSearxngSearchState();
  }

  return {
    latencyMs: Date.now() - started,
    httpStatus: response.status,
    resultCount,
    unresponsiveEngines
  };
}
