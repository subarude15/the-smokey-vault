export const UNTAPPD_DELAY_MS = Number(process.env.UNTAPPD_DELAY_MS ?? 400);
export const UNTAPPD_TIMEOUT_MS = 12_000;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export type UntappdScrapeHit = {
  untappd_bid: string | null;
  brewery: string;
  name: string;
  style: string;
  abv: number | null;
  image_url: string | null;
  page_url: string | null;
};

let lastUntappdAt = 0;

export function resetUntappdDelay() {
  lastUntappdAt = 0;
}

export function isUntappdScrapeEnabled() {
  return String(process.env.UNTAPPD_SCRAPE_ENABLED ?? "").trim().toLowerCase() === "true";
}

async function politePause() {
  const wait = UNTAPPD_DELAY_MS - (Date.now() - lastUntappdAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function metaContent(html: string, property: string) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return decodeEntities((match?.[1] || match?.[2] || "").trim());
}

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseTitle(raw: string) {
  const title = decodeEntities(raw.trim());
  const withoutSite = title.replace(/\s+-\s+Untappd\s*$/i, "").trim();
  const parts = withoutSite.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { name: parts[0]!.trim(), brewery: parts.slice(1).join(" - ").trim() };
  }
  return { name: withoutSite, brewery: "" };
}

function parseAbv(html: string): number | null {
  const match = html.match(/\b(\d+(?:\.\d+)?)\s*%\s*ABV\b/i) ?? html.match(/\bABV[^0-9]{0,8}(\d+(?:\.\d+)?)\s*%/i);
  if (!match) return null;
  const abv = Number.parseFloat(match[1]!);
  return Number.isFinite(abv) ? abv : null;
}

function parseStyle(html: string): string {
  const match = html.match(/class=["'][^"']*style[^"']*["'][^>]*>([^<]+)</i)
    ?? html.match(/>\s*([A-Za-z /-]+(?:IPA|Ale|Lager|Stout|Porter|Wheat|Sour|Cider|Seltzer)[^<]{0,40})<\//i);
  return decodeEntities(match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

export function parseUntappdBeerHtml(html: string, pageUrl = ""): UntappdScrapeHit | null {
  const text = String(html ?? "");
  if (!text.trim()) return null;
  const ogTitle = metaContent(text, "og:title");
  if (!ogTitle || /untappd search/i.test(ogTitle)) return null;
  const { name, brewery } = parseTitle(ogTitle);
  if (!name) return null;
  const bidMatch = pageUrl.match(/\/(\d+)\/?$/) ?? text.match(/\/b\/[^/"']+\/(\d+)/);
  return {
    untappd_bid: bidMatch?.[1] ?? null,
    brewery,
    name,
    style: parseStyle(text),
    abv: parseAbv(text),
    image_url: metaContent(text, "og:image") || null,
    page_url: pageUrl || null
  };
}

async function fetchBeerPage(url: string): Promise<UntappdScrapeHit | null> {
  await politePause();
  lastUntappdAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": BROWSER_UA
      },
      redirect: "follow",
      signal: AbortSignal.timeout(UNTAPPD_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const html = await response.text();
    return parseUntappdBeerHtml(html, response.url || url);
  } catch {
    return null;
  }
}

function candidateUrls(brewery: string, name: string): string[] {
  const brewerySlug = slugify(brewery);
  const nameSlug = slugify(name);
  const combined = slugify(`${brewery} ${name}`);
  const urls = new Set<string>();
  if (brewerySlug && nameSlug) urls.add(`https://untappd.com/b/${brewerySlug}-${nameSlug}/`);
  if (combined) urls.add(`https://untappd.com/b/${combined}/`);
  if (nameSlug) urls.add(`https://untappd.com/b/${nameSlug}/`);
  return [...urls];
}

/** Best-effort label enrichment from public beer pages — not a search API. */
export async function enrichFromUntappdPage(brewery: string, name: string): Promise<UntappdScrapeHit | null> {
  if (!isUntappdScrapeEnabled()) return null;
  const candidates = candidateUrls(brewery, name);
  for (const url of candidates) {
    const hit = await fetchBeerPage(url);
    if (hit?.image_url || (hit?.name && hit.brewery)) return hit;
  }
  return null;
}
