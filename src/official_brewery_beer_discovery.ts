/**
 * Official brewery product-page discovery for packaged beer.
 *
 * Starts from an established brewery identity/domain and searches ONLY that
 * brewery's own site. No third-party search engines, retail sites, or fuzzy
 * identity correction.
 */

import { beerTextTokens, foldBeerText } from "./beer_search_query.js";
import {
  hostMatchesDiscoveredDomain,
  registeredDomain
} from "./ingestion/enrichment/official-domain.js";
import { NetworkSafetyError, parseSafeHttpUrl } from "./network_safety.js";

export type OfficialBeerDiscoveryInput = {
  breweryName: string;
  beerName: string;
  breweryWebsiteUrl?: string | null;
  breweryWebsiteHost?: string | null;
  style?: string | null;
  upc?: string | null;
  catalogBeerId?: string | null;
  openBreweryDbId?: string | null;
};

export type OfficialBeerPageMatch = "exact_name" | "strong_name" | "weak" | "none";

export type OfficialBeerExtractedFields = {
  productName: string | null;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  ibu: number | null;
  description: string | null;
  tastingNotes: string | null;
  packageSizes: string[];
  productPageUrl: string | null;
  canonicalUrl: string | null;
  imageUrl: string | null;
};

export type OfficialBeerDiscoveryStatus =
  | "matched"
  | "not_found"
  | "disabled"
  | "unsupported_static_site"
  | "invalid_input"
  | "error";

export type OfficialBeerDiscoveryResult = {
  status: OfficialBeerDiscoveryStatus;
  match: OfficialBeerPageMatch;
  productPageUrl: string | null;
  registeredDomain: string | null;
  fields: OfficialBeerExtractedFields;
  pagesFetched: number;
  reason?: string;
};

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const POSITIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_FOUND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SITEMAP_URLS = 80;
const MAX_CHILD_SITEMAPS = 3;
const MAX_DESCRIPTION_CHARS = 4_000;

const PRODUCT_PATH_HINTS = [
  "beer",
  "beers",
  "brew",
  "brews",
  "year-round",
  "yearround",
  "seasonal",
  "product",
  "products",
  "our-beers",
  "ourbeers",
  "beer-finder",
  "beerfinder"
];

const REJECT_PATH_HINTS = [
  "/events/",
  "/event/",
  "/blog/",
  "/news/",
  "/press/",
  "/careers/",
  "/contact/",
  "/locations/",
  "/taproom/",
  "/store/",
  "/shop/",
  "/merch/",
  "/cart/",
  "/search/",
  "/account/",
  "/login/",
  "/checkout/"
];

type CacheEntry = {
  result: OfficialBeerDiscoveryResult;
  expiresAt: number;
};

const discoveryCache = new Map<string, CacheEntry>();

type FetchHtmlFn = (
  url: string
) => Promise<{ finalUrl: string; html: string; contentType: string }>;

export type OfficialBeerDiscoveryDeps = {
  fetchHtml?: FetchHtmlFn;
  nowMs?: () => number;
  maxPages?: number;
  maxDepth?: number;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
};

function emptyFields(): OfficialBeerExtractedFields {
  return {
    productName: null,
    brewery: null,
    style: null,
    abv: null,
    ibu: null,
    description: null,
    tastingNotes: null,
    packageSizes: [],
    productPageUrl: null,
    canonicalUrl: null,
    imageUrl: null
  };
}

export function isOfficialBreweryDiscoveryEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = String(env.OFFICIAL_BREWERY_DISCOVERY_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

export function clearOfficialBeerDiscoveryCache(): void {
  discoveryCache.clear();
}

function logDiscovery(event: string, details: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...details }));
}

function normalizeHost(value: string | null | undefined): string | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const cleaned = raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return cleaned || null;
}

function cacheKey(input: OfficialBeerDiscoveryInput, domain: string): string {
  return `${foldBeerText(domain)}|${foldBeerText(input.beerName)}`;
}

export function resolveOfficialBreweryOrigin(input: OfficialBeerDiscoveryInput): {
  origin: string;
  host: string;
  domain: string;
} | null {
  const candidates = [
    String(input.breweryWebsiteUrl || "").trim(),
    normalizeHost(input.breweryWebsiteHost)
      ? `https://${normalizeHost(input.breweryWebsiteHost)}`
      : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const url = parseSafeHttpUrl(candidate);
      const domain = registeredDomain(url.hostname);
      if (!domain) continue;
      return {
        origin: `${url.protocol}//${url.hostname}`,
        host: url.hostname.toLowerCase(),
        domain
      };
    } catch {
      // try next
    }
  }
  return null;
}

function pathLooksRejected(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return REJECT_PATH_HINTS.some((hint) => p.includes(hint));
}

function pathLooksProductish(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return PRODUCT_PATH_HINTS.some((hint) => p.includes(hint));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractLocUrls(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < MAX_SITEMAP_URLS * 2) {
    const loc = decodeXmlEntities(String(m[1] || "").trim());
    if (loc) out.push(loc);
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html: string, propertyOrName: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${propertyOrName}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${propertyOrName}["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  const value = String(m?.[1] || m?.[2] || "").trim();
  return value || null;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const value = stripTags(String(m?.[1] || "")).trim();
  return value || null;
}

function extractH1(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const value = stripTags(String(m?.[1] || "")).trim();
  return value || null;
}

function extractCanonical(html: string, baseUrl: string): string | null {
  const m = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>|<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i
  );
  const raw = String(m?.[1] || m?.[2] || "").trim();
  if (!raw) return null;
  try {
    return parseSafeHttpUrl(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = String(m[1] || "").trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return blocks;
}

function walkJsonLd(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, visit);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  visit(obj);
  if (obj["@graph"]) walkJsonLd(obj["@graph"], visit);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      if (typeof nested.name === "string" && nested.name.trim()) return nested.name.trim();
      if (typeof nested["@value"] === "string" && nested["@value"].trim()) {
        return nested["@value"].trim();
      }
    }
  }
  return null;
}

function parseAbvPercent(raw: string | null | undefined): number | null {
  const text = String(raw || "");
  if (!text) return null;
  if (/\d+\s*%\s*off\b/i.test(text) && !/\b(abv|alcohol)\b/i.test(text)) {
    return null;
  }
  const labeled = text.match(
    /\b(?:abv|alcohol(?:\s+by\s+volume)?)\b[^0-9%]{0,12}(\d{1,2}(?:\.\d{1,2})?)\s*%/i
  );
  const plain = text.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:abv|alcohol\b)/i);
  const lone = text.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*%\b/);
  const m = labeled || plain || (/\b(abv|alcohol)\b/i.test(text) ? lone : null);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0 || value > 25) return null;
  return Math.round(value * 10) / 10;
}

function parseIbuValue(raw: string | null | undefined): number | null {
  const text = String(raw || "");
  if (!text) return null;
  const m =
    text.match(/\b(?:ibu|ibus)\b[^0-9]{0,8}(\d{1,3}(?:\.\d+)?)\b/i) ||
    text.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:ibu|ibus)\b/i);
  if (!m) return null;
  const value = Math.round(Number(m[1]));
  if (!Number.isFinite(value) || value < 0 || value > 200) return null;
  return value;
}

function extractPackageSizes(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b(\d{1,2}(?:\.\d+)?)\s*(oz|ounce|ounces|ml|milliliter|milliliters)\b(?:\s*(cans?|bottles?|pack))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const amount = m[1];
    const unitRaw = String(m[2] || "").toLowerCase();
    const unit = unitRaw.startsWith("oz") || unitRaw.startsWith("ounce") ? "oz" : "ml";
    const container = String(m[3] || "").toLowerCase();
    const label = container ? `${amount} ${unit} ${container}` : `${amount} ${unit}`;
    if (!out.includes(label)) out.push(label);
    if (out.length >= 6) break;
  }
  return out;
}

function tokenCoverage(queryTokens: string[], candidate: string): number {
  if (!queryTokens.length) return 0;
  const hay = new Set(beerTextTokens(candidate));
  let hit = 0;
  for (const token of queryTokens) {
    if (hay.has(token)) hit += 1;
  }
  return hit / queryTokens.length;
}

export function classifyOfficialBeerPageMatch(args: {
  beerName: string;
  breweryName: string;
  title: string | null;
  h1: string | null;
  productName: string | null;
  pageUrl: string;
  pageText: string;
}): OfficialBeerPageMatch {
  const beerFold = foldBeerText(args.beerName);
  const beerTokens = beerTextTokens(args.beerName);
  if (!beerFold || beerTokens.length === 0) return "none";

  const pathname = (() => {
    try {
      return new URL(args.pageUrl).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (pathLooksRejected(pathname)) return "none";

  const titleFold = foldBeerText(args.title || "");
  const h1Fold = foldBeerText(args.h1 || "");
  const productFold = foldBeerText(args.productName || "");
  const pageFold = foldBeerText(args.pageText.slice(0, 8_000));

  const exactIn =
    (titleFold && (titleFold === beerFold || titleFold.startsWith(`${beerFold} `))) ||
    (h1Fold && (h1Fold === beerFold || h1Fold.startsWith(`${beerFold} `))) ||
    (productFold && productFold === beerFold);

  if (exactIn) {
    const breweryNearby =
      foldBeerText(args.breweryName)
        .split(/\s+/)
        .filter((t) => t.length > 2)
        .some((t) => titleFold.includes(t) || h1Fold.includes(t) || pageFold.includes(t)) ||
      pathLooksProductish(pathname) ||
      Boolean(args.productName);
    return breweryNearby || exactIn ? "exact_name" : "strong_name";
  }

  const titleCoverage = tokenCoverage(beerTokens, args.title || "");
  const h1Coverage = tokenCoverage(beerTokens, args.h1 || "");
  const productCoverage = tokenCoverage(beerTokens, args.productName || "");
  const bestCoverage = Math.max(titleCoverage, h1Coverage, productCoverage);

  if (bestCoverage >= 1 && (pathLooksProductish(pathname) || Boolean(args.productName))) {
    return "strong_name";
  }
  if (bestCoverage >= 0.8 && pageFold.includes(beerFold)) {
    return "weak";
  }
  return "none";
}

function extractFromJsonLd(blocks: unknown[]): Partial<OfficialBeerExtractedFields> {
  const out: Partial<OfficialBeerExtractedFields> = {};
  walkJsonLd(blocks, (obj) => {
    const typeRaw = obj["@type"];
    const types = Array.isArray(typeRaw)
      ? typeRaw.map((t) => String(t).toLowerCase())
      : [String(typeRaw || "").toLowerCase()];
    const isProductish = types.some((t) =>
      ["product", "beverages", "alcoholicbeverage"].includes(t)
    );
    if (!isProductish && !obj.name) return;

    if (!out.productName) out.productName = firstString(obj.name);
    if (!out.description) out.description = firstString(obj.description);
    if (!out.imageUrl) {
      const image = obj.image;
      if (typeof image === "string") out.imageUrl = image;
      else if (Array.isArray(image) && typeof image[0] === "string") out.imageUrl = image[0];
      else if (image && typeof image === "object" && typeof (image as { url?: unknown }).url === "string") {
        out.imageUrl = String((image as { url: string }).url);
      }
    }
    if (!out.brewery) {
      out.brewery = firstString(obj.brand, obj.manufacturer, obj.producer);
    }
    const additional = obj.additionalProperty;
    const props = Array.isArray(additional) ? additional : additional ? [additional] : [];
    for (const prop of props) {
      if (!prop || typeof prop !== "object") continue;
      const p = prop as Record<string, unknown>;
      const name = String(p.name || "").toLowerCase();
      const value = String(p.value ?? "");
      if (!out.abv && /abv|alcohol/.test(name)) out.abv = parseAbvPercent(`${name} ${value}`);
      if (!out.ibu && /ibu/.test(name)) out.ibu = parseIbuValue(`${name} ${value}`);
      if (!out.style && /style/.test(name) && value.trim()) out.style = value.trim();
    }
  });
  return out;
}

export function extractOfficialBeerMetadata(args: {
  html: string;
  pageUrl: string;
  beerName: string;
  breweryName: string;
}): OfficialBeerExtractedFields {
  const { html, pageUrl } = args;
  const title = extractTitle(html);
  const h1 = extractH1(html);
  const ogTitle = extractMetaContent(html, "og:title");
  const ogDescription = extractMetaContent(html, "og:description");
  const ogImage = extractMetaContent(html, "og:image");
  const canonicalUrl = extractCanonical(html, pageUrl);
  const jsonLd = extractFromJsonLd(extractJsonLdBlocks(html));
  const text = stripTags(html).slice(0, 20_000);

  const productName =
    jsonLd.productName ||
    h1 ||
    (ogTitle && foldBeerText(ogTitle).includes(foldBeerText(args.beerName)) ? ogTitle : null) ||
    (title ? title.split(/\s*[|\-–—]\s*/)[0]?.trim() || null : null);

  const descriptionRaw =
    jsonLd.description ||
    ogDescription ||
    extractMetaContent(html, "description") ||
    null;
  const description = descriptionRaw
    ? stripTags(descriptionRaw).slice(0, MAX_DESCRIPTION_CHARS) || null
    : null;

  const abv = jsonLd.abv ?? parseAbvPercent(text) ?? parseAbvPercent(description) ?? null;
  const ibu = jsonLd.ibu ?? parseIbuValue(text) ?? parseIbuValue(description) ?? null;

  let style = jsonLd.style || null;
  if (!style) {
    const styleMatch = text.match(/\bstyle\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 &'/-]{1,60})/i);
    if (styleMatch?.[1]) style = styleMatch[1].trim();
  }

  let tastingNotes: string | null = null;
  const notesMatch = text.match(
    /\b(?:tasting notes?|flavor notes?)\s*[:\-]\s*([^.!?]{8,240})/i
  );
  if (notesMatch?.[1]) tastingNotes = notesMatch[1].trim();

  const packageSizes = extractPackageSizes(text);

  let imageUrl = jsonLd.imageUrl || ogImage || null;
  if (imageUrl) {
    try {
      imageUrl = parseSafeHttpUrl(imageUrl, pageUrl).toString();
    } catch {
      imageUrl = null;
    }
  }

  return {
    productName: productName ? stripTags(productName).slice(0, 200) || null : null,
    brewery: jsonLd.brewery || args.breweryName || null,
    style: style ? style.slice(0, 120) : null,
    abv,
    ibu,
    description,
    tastingNotes,
    packageSizes,
    productPageUrl: pageUrl,
    canonicalUrl,
    imageUrl
  };
}

function sameOfficialDomain(candidateUrl: string, domain: string): boolean {
  try {
    const parsed = parseSafeHttpUrl(candidateUrl);
    return hostMatchesDiscoveredDomain(parsed.hostname, domain);
  } catch {
    return false;
  }
}

async function defaultFetchHtml(
  url: string,
  opts: { maxRedirects: number; maxBytes: number; timeoutMs: number; domain: string }
): Promise<{ finalUrl: string; html: string; contentType: string }> {
  let current = parseSafeHttpUrl(url).toString();
  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "SmokeyVaultOfficialBeerDiscovery/1.0"
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect_missing_location");
        const next = parseSafeHttpUrl(location, current);
        if (!hostMatchesDiscoveredDomain(next.hostname, opts.domain)) {
          throw new Error("redirect_left_official_domain");
        }
        current = next.toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > opts.maxBytes) {
        throw new Error("response_too_large");
      }
      return {
        finalUrl: current,
        html: buffer.toString("utf8"),
        contentType
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too_many_redirects");
}

type Budget = { pagesFetched: number; maxPages: number };

type FetchCtx = {
  fetchHtml?: FetchHtmlFn;
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  domain: string;
};

async function fetchPage(
  url: string,
  ctx: FetchCtx,
  budget: Budget
): Promise<{ finalUrl: string; html: string; contentType: string } | null> {
  if (budget.pagesFetched >= budget.maxPages) return null;
  budget.pagesFetched += 1;
  try {
    if (ctx.fetchHtml) return await ctx.fetchHtml(url);
    return await defaultFetchHtml(url, {
      maxRedirects: ctx.maxRedirects,
      maxBytes: ctx.maxBytes,
      timeoutMs: ctx.timeoutMs,
      domain: ctx.domain
    });
  } catch (err) {
    if (err instanceof NetworkSafetyError) return null;
    if (err instanceof Error && /aborted|timeout/i.test(err.message)) return null;
    return null;
  }
}

function prioritizeUrls(urls: string[], domain: string, beerName: string): string[] {
  const beerFold = foldBeerText(beerName).replace(/\s+/g, "-");
  const beerSlug = foldBeerText(beerName).replace(/\s+/g, "");
  const scored = urls
    .filter((url) => sameOfficialDomain(url, domain))
    .map((url) => {
      let score = 0;
      try {
        const parsed = new URL(url);
        const path = parsed.pathname.toLowerCase();
        if (pathLooksRejected(path)) score -= 100;
        if (pathLooksProductish(path)) score += 20;
        if (beerFold && path.includes(beerFold)) score += 40;
        if (beerSlug && path.includes(beerSlug)) score += 30;
      } catch {
        score -= 50;
      }
      return { url, score };
    })
    .sort((a, b) => b.score - a.score);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    if (seen.has(item.url) || item.score < 0) continue;
    seen.add(item.url);
    out.push(item.url);
    if (out.length >= MAX_SITEMAP_URLS) break;
  }
  return out;
}

async function collectSitemapCandidateUrls(
  origin: string,
  domain: string,
  beerName: string,
  ctx: FetchCtx,
  budget: Budget
): Promise<string[]> {
  const roots = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const urls: string[] = [];

  for (const root of roots) {
    const page = await fetchPage(root, ctx, budget);
    if (!page) continue;
    if (!/xml|text|html/i.test(page.contentType) && !page.html.includes("<loc>")) continue;
    logDiscovery("official_beer_sitemap_hit", { url: root, domain });

    if (isSitemapIndex(page.html)) {
      const childMaps = extractLocUrls(page.html)
        .filter((u) => sameOfficialDomain(u, domain))
        .slice(0, MAX_CHILD_SITEMAPS);
      for (const child of childMaps) {
        const childPage = await fetchPage(child, ctx, budget);
        if (!childPage) continue;
        urls.push(...extractLocUrls(childPage.html));
      }
    } else {
      urls.push(...extractLocUrls(page.html));
    }
  }

  return prioritizeUrls(urls, domain, beerName);
}

function extractSameDomainLinks(html: string, baseUrl: string, domain: string): string[] {
  const out: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 40) {
    const href = String(m[1] || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    try {
      const abs = parseSafeHttpUrl(href, baseUrl);
      if (!hostMatchesDiscoveredDomain(abs.hostname, domain)) continue;
      if (pathLooksRejected(abs.pathname)) continue;
      out.push(abs.toString());
    } catch {
      // skip unsafe
    }
  }
  return out;
}

type EvaluatedPage = {
  match: OfficialBeerPageMatch;
  url: string;
  fields: OfficialBeerExtractedFields;
  html: string;
  finalUrl: string;
};

async function evaluateCandidatePage(
  url: string,
  input: OfficialBeerDiscoveryInput,
  domain: string,
  ctx: FetchCtx,
  budget: Budget
): Promise<EvaluatedPage | null> {
  if (!sameOfficialDomain(url, domain)) return null;
  try {
    if (pathLooksRejected(new URL(url).pathname)) return null;
  } catch {
    return null;
  }

  const page = await fetchPage(url, ctx, budget);
  if (!page) return null;
  if (!/html|xml|text/i.test(page.contentType) && !/<html/i.test(page.html)) return null;
  if (!sameOfficialDomain(page.finalUrl, domain)) return null;

  const fields = extractOfficialBeerMetadata({
    html: page.html,
    pageUrl: page.finalUrl,
    beerName: input.beerName,
    breweryName: input.breweryName
  });
  const title = extractTitle(page.html);
  const h1 = extractH1(page.html);
  const match = classifyOfficialBeerPageMatch({
    beerName: input.beerName,
    breweryName: input.breweryName,
    title,
    h1,
    productName: fields.productName,
    pageUrl: page.finalUrl,
    pageText: stripTags(page.html)
  });

  if (match === "exact_name" || match === "strong_name") {
    logDiscovery("official_beer_product_match", {
      url: page.finalUrl,
      match,
      beerName: input.beerName
    });
    logDiscovery("official_beer_extract", {
      url: page.finalUrl,
      hasAbv: fields.abv != null,
      hasIbu: fields.ibu != null,
      hasImage: Boolean(fields.imageUrl)
    });
    return {
      match,
      url: fields.canonicalUrl || page.finalUrl,
      fields,
      html: page.html,
      finalUrl: page.finalUrl
    };
  }

  return {
    match,
    url: page.finalUrl,
    fields,
    html: page.html,
    finalUrl: page.finalUrl
  };
}

export async function discoverOfficialBeerProductPage(
  input: OfficialBeerDiscoveryInput,
  deps: OfficialBeerDiscoveryDeps = {}
): Promise<OfficialBeerDiscoveryResult> {
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  if (!isOfficialBreweryDiscoveryEnabled()) {
    return {
      status: "disabled",
      match: "none",
      productPageUrl: null,
      registeredDomain: null,
      fields: emptyFields(),
      pagesFetched: 0,
      reason: "feature_disabled"
    };
  }

  const beerName = String(input.beerName || "").trim();
  const breweryName = String(input.breweryName || "").trim();
  if (!beerName || !breweryName) {
    return {
      status: "invalid_input",
      match: "none",
      productPageUrl: null,
      registeredDomain: null,
      fields: emptyFields(),
      pagesFetched: 0,
      reason: "brewery_and_beer_required"
    };
  }

  const originInfo = resolveOfficialBreweryOrigin(input);
  if (!originInfo) {
    return {
      status: "invalid_input",
      match: "none",
      productPageUrl: null,
      registeredDomain: null,
      fields: emptyFields(),
      pagesFetched: 0,
      reason: "official_domain_required"
    };
  }

  const key = cacheKey({ ...input, beerName, breweryName }, originInfo.domain);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ...cached.result, reason: cached.result.reason || "cache_hit" };
  }

  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  const ctx: FetchCtx = {
    fetchHtml: deps.fetchHtml,
    maxRedirects: deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    domain: originInfo.domain
  };
  const budget: Budget = { pagesFetched: 0, maxPages };

  logDiscovery("official_beer_discovery_start", {
    brewery: breweryName,
    beer: beerName,
    domain: originInfo.domain
  });

  try {
    const sitemapUrls = await collectSitemapCandidateUrls(
      originInfo.origin,
      originInfo.domain,
      beerName,
      ctx,
      budget
    );

    const seedUrls = [
      ...sitemapUrls,
      `${originInfo.origin}/`,
      `${originInfo.origin}/beers`,
      `${originInfo.origin}/beer`,
      `${originInfo.origin}/our-beers`,
      `${originInfo.origin}/products`
    ];

    const queue: Array<{ url: string; depth: number }> = [];
    const seen = new Set<string>();
    for (const url of seedUrls) {
      if (!sameOfficialDomain(url, originInfo.domain)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push({ url, depth: url === `${originInfo.origin}/` ? 0 : 1 });
    }

    let best: EvaluatedPage | null = null;

    while (queue.length > 0 && budget.pagesFetched < maxPages) {
      const next = queue.shift()!;
      const evaluated = await evaluateCandidatePage(
        next.url,
        { ...input, beerName, breweryName },
        originInfo.domain,
        ctx,
        budget
      );
      if (!evaluated) continue;

      if (evaluated.match === "exact_name" || evaluated.match === "strong_name") {
        best = evaluated;
        if (evaluated.match === "exact_name") break;
      }

      if (next.depth >= maxDepth) continue;
      const links = prioritizeUrls(
        extractSameDomainLinks(evaluated.html, evaluated.finalUrl, originInfo.domain),
        originInfo.domain,
        beerName
      ).slice(0, 12);
      for (const link of links) {
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ url: link, depth: next.depth + 1 });
      }
    }

    if (!best || (best.match !== "exact_name" && best.match !== "strong_name")) {
      logDiscovery("official_beer_not_found", {
        domain: originInfo.domain,
        beer: beerName,
        pagesFetched: budget.pagesFetched
      });
      const result: OfficialBeerDiscoveryResult = {
        status: budget.pagesFetched <= 2 ? "unsupported_static_site" : "not_found",
        match: "none",
        productPageUrl: null,
        registeredDomain: originInfo.domain,
        fields: emptyFields(),
        pagesFetched: budget.pagesFetched,
        reason: budget.pagesFetched <= 2 ? "unsupported_static_site" : "no_strong_match"
      };
      discoveryCache.set(key, { result, expiresAt: now + NOT_FOUND_CACHE_TTL_MS });
      return result;
    }

    const result: OfficialBeerDiscoveryResult = {
      status: "matched",
      match: best.match,
      productPageUrl: best.url,
      registeredDomain: originInfo.domain,
      fields: {
        ...best.fields,
        productPageUrl: best.url,
        canonicalUrl: best.fields.canonicalUrl || best.url
      },
      pagesFetched: budget.pagesFetched,
      reason: "matched"
    };
    discoveryCache.set(key, { result, expiresAt: now + POSITIVE_CACHE_TTL_MS });
    return result;
  } catch (err) {
    logDiscovery("official_beer_discovery_error", {
      domain: originInfo.domain,
      error: err instanceof Error ? err.message.slice(0, 160) : "error"
    });
    return {
      status: "error",
      match: "none",
      productPageUrl: null,
      registeredDomain: originInfo.domain,
      fields: emptyFields(),
      pagesFetched: budget.pagesFetched,
      reason: err instanceof Error ? err.message.slice(0, 160) : "error"
    };
  }
}
