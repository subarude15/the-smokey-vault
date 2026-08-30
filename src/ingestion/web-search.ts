/** Local SearXNG JSON search used when catalogs miss a bottle. */
const LOCAL_SEARXNG_SEARCH_URL = "http://192.168.1.184:8888/search";

type SearxResult = {
  title?: string;
  content?: string;
};

type SearxSearchResponse = {
  results?: SearxResult[];
};

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
