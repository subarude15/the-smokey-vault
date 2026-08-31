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
  | "network"
  | "unreachable";

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly provider = "searxng" as const;
  readonly httpStatus?: number;

  constructor(code: WebSearchErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
    this.httpStatus = httpStatus;
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
};

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
  return data as SearxSearchResponse;
}

export async function searchWebHits(query: string, limit = 5): Promise<WebSearchHit[]> {
  const data = await searxngFetch(query);
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

/** SearXNG image-category search; throws WebSearchError on provider failure. */
export async function searchImageHitsFromSearx(query: string, limit = 8): Promise<ImageSearchSeed[]> {
  const data = await searxngFetch(query, { categories: "images" });
  const out: ImageSearchSeed[] = [];
  for (const row of (data.results ?? []).slice(0, Math.max(0, limit))) {
    const imageUrl = String(row.img_src || row.thumbnail_src || row.thumbnail || row.url || "").trim();
    const pageUrl = String(row.url || "").trim() || null;
    if (!imageUrl.startsWith("http")) continue;
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
  return out;
}

export function isWebSearchError(error: unknown): error is WebSearchError {
  return error instanceof WebSearchError;
}
