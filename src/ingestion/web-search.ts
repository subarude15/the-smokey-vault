/** Local SearXNG JSON search used when catalogs miss a bottle. */
const LOCAL_SEARXNG_SEARCH_URL = "http://192.168.1.184:8888/search";

type SearxResult = {
  title?: string;
  content?: string;
  url?: string;
};

type SearxSearchResponse = {
  results?: SearxResult[];
};

export type WebSearchHit = {
  title: string;
  content: string;
  url: string;
};

export async function searchWebHits(query: string, limit = 5): Promise<WebSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const params = new URLSearchParams({ q, format: "json" });
    const response = await fetch(`${LOCAL_SEARXNG_SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return [];
    const data = await response.json() as SearxSearchResponse;
    const results = (data.results ?? []).slice(0, Math.max(0, limit));
    return results
      .map((result) => {
        const title = String(result.title ?? "").trim();
        const content = String(result.content ?? "").trim();
        const url = String(result.url ?? "").trim();
        // URL is preferred for tasting-note attribution, but title/content-only
        // hits still count for snippet formatting used by metadata enrichment.
        if (!title && !content) return null;
        return { title, content, url };
      })
      .filter((hit): hit is WebSearchHit => Boolean(hit));
  } catch {
    return [];
  }
}

export async function searchWebSnippets(query: string, limit = 5): Promise<string> {
  const q = query.trim();
  if (!q) return "";
  try {
    const params = new URLSearchParams({ q, format: "json" });
    const response = await fetch(`${LOCAL_SEARXNG_SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return "";
    const data = await response.json() as SearxSearchResponse;
    const results = (data.results ?? []).slice(0, Math.max(0, limit));
    if (!results.length) return "";
    return results
      .map((result, index) => {
        const title = String(result.title ?? "").trim();
        const content = String(result.content ?? "").trim();
        if (!title && !content) return "";
        return `${index + 1}. ${title}${title && content ? " — " : ""}${content}`;
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}
