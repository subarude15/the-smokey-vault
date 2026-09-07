/**
 * Official brewery product-page discovery for packaged beer.
 *
 * Starts from an established brewery identity/domain and searches ONLY that
 * brewery's own site. No third-party search engines, retail sites, or fuzzy
 * identity correction.
 */

import { Readable } from "node:stream";
import { beerTextTokens, foldBeerText } from "./beer_search_query.js";
import {
  hostMatchesDiscoveredDomain,
  registeredDomain
} from "./ingestion/enrichment/official-domain.js";
import {
  NetworkSafetyError,
  fetchSafeHttp,
  headerValue,
  parseSafeHttpUrl,
  type LookupFn,
  type PinnedRequestFn
} from "./network_safety.js";
import {
  OFFICIAL_BEER_BROWSER_MAX_PAGES,
  isOfficialBeerBrowserConfigured,
  renderOfficialBreweryBeerPage,
  type OfficialBeerBrowserDeps,
  type OfficialBeerBrowserOutcome
} from "./official_brewery_beer_browser.js";

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
/** Cap guessed product-page fetches so sitemap/index crawl retains budget. */
export const MAX_GUESSED_PRODUCT_FETCHES = 4;
/**
 * Generic official product-path prefixes (deterministic order).
 * Prefer common beer/product stems first; never brewery-specific.
 */
export const OFFICIAL_BEER_PRODUCT_PATH_PREFIXES = [
  "/beer/",
  "/beers/",
  "/our-beer/",
  "/our-beers/",
  "/products/",
  "/product/",
  "/brew/",
  "/brews/"
] as const;
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
  /** Injected into fetchSafeHttp for SSRF tests (no live DNS). */
  lookup?: LookupFn;
  /** Injected into fetchSafeHttp for SSRF / redirect tests. */
  request?: PinnedRequestFn;
  /**
   * Optional Figranium render hook for JS-dependent official sites.
   * Tests inject stubs; production uses renderOfficialBreweryBeerPage when configured.
   */
  renderOfficialPage?: (
    input: {
      url: string;
      breweryName: string;
      beerName: string;
      registeredDomain: string;
    }
  ) => Promise<OfficialBeerBrowserOutcome>;
  /** Override browser enablement (tests). Default: FIGRANIUM_OFFICIAL_BEER_TASK_ID configured. */
  browserFallbackEnabled?: boolean;
  browserDeps?: OfficialBeerBrowserDeps;
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

  // A known spaced compound may be presented unspaced by the brewery
  // ("Dirt wolf" → "DirtWolf"). Treat only exact alphanumeric compaction as
  // strong identity; do not drop, reorder, stem, or typo-correct any token.
  const compactBeer = beerFold.replace(/[^a-z0-9]/g, "");
  const compactIdentityMatch =
    beerTokens.length > 1
    && compactBeer.length >= 6
    && [titleFold, h1Fold, productFold].some((value) => {
      const compact = value.replace(/[^a-z0-9]/g, "");
      return compact === compactBeer;
    });
  if (compactIdentityMatch && (pathLooksProductish(pathname) || Boolean(args.productName))) {
    return "strong_name";
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

const STYLE_LABEL_RE =
  /^(?:beer\s*)?(?:style|type|category|classification|variety)$/i;
const NOTES_LABEL_RE =
  /^(?:notes?|tasting\s*notes?|flavor\s*notes?|description|about|overview)$/i;
const DESCRIPTION_BOILERPLATE_RE =
  /\b(you must be\s*21|must be\s*21|sign up for our newsletter|we use cookies|cookie (?:policy|notice)|shop now|find a retailer|add to cart|age gate|terms of (?:use|service)|privacy policy)\b/i;
const STYLE_MARKETING_RE =
  /^(?:bold and adventurous|hop-?forward|seasonal favorite|crisp and refreshing|smooth finish|sessionable|easy drinking)\b/i;
const REJECTED_IMAGE_PATH_RE =
  /(?:favicon|logo|sprite|icon|avatar|badge|social|facebook|twitter|instagram|pinterest|youtube|tiktok|tracking|pixel|1x1|spacer|wordmark|header-logo|site-logo)/i;

/** Collect image URL strings from JSON-LD `image` in all common Product shapes. */
export function collectJsonLdImageUrls(image: unknown): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw === "string" && raw.trim()) {
      out.push(raw.trim());
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.url === "string" && obj.url.trim()) out.push(obj.url.trim());
    if (typeof obj.contentUrl === "string" && obj.contentUrl.trim()) {
      out.push(obj.contentUrl.trim());
    }
  };
  if (Array.isArray(image)) {
    for (const item of image) push(item);
  } else {
    push(image);
  }
  return out;
}

export function isRejectedOfficialImageCandidate(
  rawUrl: string,
  alt: string = ""
): boolean {
  const value = String(rawUrl || "").trim();
  if (!value) return true;
  const lower = value.toLowerCase();
  if (
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("javascript:")
  ) {
    return true;
  }
  if (REJECTED_IMAGE_PATH_RE.test(lower) || REJECTED_IMAGE_PATH_RE.test(alt)) {
    return true;
  }
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.toLowerCase();
    if (/\.(svg|ico)(\?|$)/i.test(path)) return true;
  } catch {
    if (/\.(svg|ico)(\?|$)/i.test(lower)) return true;
  }
  return false;
}

function absolutizeOfficialImageUrl(
  raw: string,
  pageUrl: string
): string | null {
  if (isRejectedOfficialImageCandidate(raw)) return null;
  try {
    const abs = parseSafeHttpUrl(raw, pageUrl).toString();
    if (isRejectedOfficialImageCandidate(abs)) return null;
    return abs;
  } catch {
    return null;
  }
}

function normalizeStyleValue(raw: string | null | undefined): string | null {
  const value = stripTags(String(raw || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!value || value.length < 2 || value.length > 80) return null;
  if (STYLE_MARKETING_RE.test(value)) return null;
  if (DESCRIPTION_BOILERPLATE_RE.test(value)) return null;
  if (/[.!?]/.test(value) || value.split(/\s+/).length > 8) return null;
  return value.slice(0, 120);
}

function normalizeDescriptionValue(raw: string | null | undefined): string | null {
  const value = stripTags(String(raw || ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!value || value.length < 24) return null;
  if (DESCRIPTION_BOILERPLATE_RE.test(value)) return null;
  return value.slice(0, MAX_DESCRIPTION_CHARS) || null;
}

function extractLabeledTableMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html))) {
    const th = row[1]!.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
    const td = row[1]!.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
    if (!th || !td) continue;
    const label = stripTags(th[1] || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const value = stripTags(td[1] || "")
      .replace(/\s+/g, " ")
      .trim();
    if (label && value && !map.has(label)) map.set(label, value);
  }
  return map;
}

function extractStyleFromHtml(html: string, text: string): string | null {
  const classMatch = html.match(
    /<(?:h[1-6]|p|div|span)[^>]*class=["'][^"']*\bbeer-style\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:h[1-6]|p|div|span)>/i
  );
  const fromClass = normalizeStyleValue(classMatch?.[1]);
  if (fromClass) return fromClass;

  const table = extractLabeledTableMap(html);
  for (const [label, value] of table) {
    if (STYLE_LABEL_RE.test(label)) {
      const normalized = normalizeStyleValue(value);
      if (normalized) return normalized;
    }
  }

  const labeled = text.match(
    /\b(?:beer\s*)?(?:style|type|category)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 &'\/.-]{1,60})/i
  );
  return normalizeStyleValue(labeled?.[1]);
}

function extractDescriptionFromHtml(html: string, text: string): {
  description: string | null;
  tastingNotes: string | null;
  source: string | null;
} {
  const table = extractLabeledTableMap(html);
  for (const [label, value] of table) {
    if (!NOTES_LABEL_RE.test(label)) continue;
    const normalized = normalizeDescriptionValue(value);
    if (!normalized) continue;
    if (/tasting|flavor/.test(label)) {
      return { description: null, tastingNotes: normalized, source: "table_notes" };
    }
    return { description: normalized, tastingNotes: null, source: "table_notes" };
  }

  const notesMatch = text.match(
    /\b(?:tasting notes?|flavor notes?)\s*[:\-]\s*([^.!?]{8,240})/i
  );
  const tastingNotes = normalizeDescriptionValue(notesMatch?.[1] ?? null);
  if (tastingNotes) {
    return { description: null, tastingNotes, source: "labeled_text" };
  }

  return { description: null, tastingNotes: null, source: null };
}

/**
 * Deterministic official product-page image candidates.
 * Priority: JSON-LD → og:image → twitter:image → product-scoped DOM <img>.
 */
export function extractOfficialBeerImageCandidates(args: {
  html: string;
  pageUrl: string;
  beerName: string;
}): string[] {
  const { html, pageUrl, beerName } = args;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const abs = absolutizeOfficialImageUrl(raw, pageUrl);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };

  for (const block of extractJsonLdBlocks(html)) {
    walkJsonLd(block, (obj) => {
      for (const url of collectJsonLdImageUrls(obj.image)) push(url);
    });
    if (out.length >= 6) return out.slice(0, 6);
  }

  push(extractMetaContent(html, "og:image"));
  push(extractMetaContent(html, "twitter:image"));
  push(extractMetaContent(html, "twitter:image:src"));

  const beerFold = foldBeerText(beerName);
  const beerTokens = beerTextTokens(beerName).filter((t) => t.length >= 3);
  const imgRe = /<img\b[^>]*>/gi;
  let img: RegExpExecArray | null;
  const scored: Array<{ url: string; score: number }> = [];
  while ((img = imgRe.exec(html)) && scored.length < 40) {
    const tag = img[0];
    const src =
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ||
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ||
      null;
    if (!src) continue;
    const abs = absolutizeOfficialImageUrl(src, pageUrl);
    if (!abs || seen.has(abs)) continue;
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "";
    if (isRejectedOfficialImageCandidate(abs, alt)) continue;
    const width = Number(tag.match(/\bwidth=["']?(\d+)/i)?.[1] || "");
    const height = Number(tag.match(/\bheight=["']?(\d+)/i)?.[1] || "");
    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0 &&
      (width <= 2 || height <= 2 || (width < 64 && height < 64))
    ) {
      continue;
    }
    let score = 0;
    const altFold = foldBeerText(alt);
    if (altFold && beerFold && (altFold === beerFold || altFold.includes(beerFold))) {
      score += 6;
    }
    for (const token of beerTokens.slice(0, 4)) {
      if (altFold.includes(token) || abs.toLowerCase().includes(token)) {
        score += 2;
        break;
      }
    }
    if (/render|can|bottle|pack|product|hero/i.test(abs)) score += 2;
    if (/beer-hero|product-image|wp-post-image/i.test(tag)) score += 2;
    if (score <= 0) continue;
    scored.push({ url: abs, score });
  }
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  for (const item of scored) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item.url);
    if (out.length >= 6) break;
  }

  return out.slice(0, 6);
}

function extractFromJsonLd(blocks: unknown[]): Partial<OfficialBeerExtractedFields> {
  const out: Partial<OfficialBeerExtractedFields> = {};
  walkJsonLd(blocks, (obj) => {
    const typeRaw = obj["@type"];
    const types = Array.isArray(typeRaw)
      ? typeRaw.map((t) => String(t).toLowerCase())
      : [String(typeRaw || "").toLowerCase()];
    const isProductish = types.some((t) =>
      ["product", "beverage", "alcoholicbeverage"].includes(t)
    );
    if (!isProductish && !obj.name) return;

    if (!out.productName) out.productName = firstString(obj.name);
    if (!out.description) out.description = firstString(obj.description);
    if (!out.imageUrl) {
      const images = collectJsonLdImageUrls(obj.image);
      if (images[0]) out.imageUrl = images[0];
    }
    if (!out.brewery) {
      out.brewery = firstString(obj.brand, obj.manufacturer, obj.producer);
    }
    if (!out.style) {
      out.style =
        normalizeStyleValue(firstString(obj.category, obj.additionalType)) || null;
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
      if (!out.style && STYLE_LABEL_RE.test(name) && value.trim()) {
        out.style = normalizeStyleValue(value);
      }
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
  const canonicalUrl = extractCanonical(html, pageUrl);
  const jsonLd = extractFromJsonLd(extractJsonLdBlocks(html));
  const text = stripTags(html).slice(0, 20_000);

  const productName =
    jsonLd.productName ||
    h1 ||
    (ogTitle && foldBeerText(ogTitle).includes(foldBeerText(args.beerName)) ? ogTitle : null) ||
    (title ? title.split(/\s*[|\-–—]\s*/)[0]?.trim() || null : null);

  const fromDom = extractDescriptionFromHtml(html, text);
  const descriptionRaw =
    jsonLd.description ||
    ogDescription ||
    extractMetaContent(html, "description") ||
    fromDom.description ||
    null;
  const description = normalizeDescriptionValue(descriptionRaw);

  const tastingNotes =
    fromDom.tastingNotes ||
    (() => {
      const notesMatch = text.match(
        /\b(?:tasting notes?|flavor notes?)\s*[:\-]\s*([^.!?]{8,240})/i
      );
      return normalizeDescriptionValue(notesMatch?.[1] ?? null);
    })();

  const abv = jsonLd.abv ?? parseAbvPercent(text) ?? parseAbvPercent(description) ?? null;
  const ibu = jsonLd.ibu ?? parseIbuValue(text) ?? parseIbuValue(description) ?? null;

  const style =
    normalizeStyleValue(jsonLd.style) || extractStyleFromHtml(html, text) || null;

  const packageSizes = extractPackageSizes(text);

  const imageCandidates = extractOfficialBeerImageCandidates({
    html,
    pageUrl,
    beerName: args.beerName
  });
  const imageUrl = imageCandidates[0] || null;

  logDiscovery("official_beer_extract_style", {
    present: Boolean(style),
    source: style ? (jsonLd.style ? "json_ld" : "dom") : null
  });
  logDiscovery("official_beer_extract_description", {
    present: Boolean(description || tastingNotes),
    source: description
      ? jsonLd.description
        ? "json_ld"
        : ogDescription
          ? "og"
          : fromDom.source || "meta"
      : tastingNotes
        ? fromDom.source || "labeled_text"
        : null
  });
  logDiscovery("official_beer_extract_image_candidate", {
    present: Boolean(imageUrl),
    candidateCount: imageCandidates.length,
    host: (() => {
      try {
        return imageUrl ? new URL(imageUrl).host : null;
      } catch {
        return null;
      }
    })()
  });

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

/** Public domain lock for browser/static callers. */
export function urlBelongsToOfficialDomain(url: string, registeredDomainName: string): boolean {
  return sameOfficialDomain(url, registeredDomainName);
}

/**
 * Positive evidence that static HTML is an app shell / JS-rendered page
 * rather than a useful product document.
 */
export function htmlLooksLikeJsAppShell(html: string): boolean {
  const raw = String(html || "");
  if (!raw) return true;
  const text = stripTags(raw).replace(/\s+/g, " ").trim();
  const scriptCount = (raw.match(/<script\b/gi) || []).length;
  const hasRoot = /id=["'](?:root|app|__next|__nuxt)["']/i.test(raw);
  const hasFramework =
    /__NEXT_DATA__|data-reactroot|ng-version|__NUXT__|webpackJsonp|vite\/client|data-server-rendered/i.test(
      raw
    );
  if (text.length < 80 && scriptCount >= 1) return true;
  if (text.length < 200 && (scriptCount >= 3 || hasRoot || hasFramework)) return true;
  if (hasRoot && text.length < 400 && scriptCount >= 2) return true;
  return false;
}

export type ScoredOfficialBeerHtml = {
  match: OfficialBeerPageMatch;
  fields: OfficialBeerExtractedFields;
  productPageUrl: string;
  finalUrl: string;
};

/** Score already-rendered official-domain HTML with PR103 match + extract rules. */
export function scoreOfficialBeerHtmlPage(args: {
  html: string;
  pageUrl: string;
  beerName: string;
  breweryName: string;
  registeredDomain: string;
}): ScoredOfficialBeerHtml | null {
  if (!sameOfficialDomain(args.pageUrl, args.registeredDomain)) return null;
  try {
    if (pathLooksRejected(new URL(args.pageUrl).pathname)) return null;
  } catch {
    return null;
  }
  const fields = extractOfficialBeerMetadata({
    html: args.html,
    pageUrl: args.pageUrl,
    beerName: args.beerName,
    breweryName: args.breweryName
  });
  const title = extractTitle(args.html);
  const h1 = extractH1(args.html);
  const match = classifyOfficialBeerPageMatch({
    beerName: args.beerName,
    breweryName: args.breweryName,
    title,
    h1,
    productName: fields.productName,
    pageUrl: args.pageUrl,
    pageText: stripTags(args.html)
  });
  const acceptedCanonical =
    fields.canonicalUrl && sameOfficialDomain(fields.canonicalUrl, args.registeredDomain)
      ? fields.canonicalUrl
      : null;
  const trustedFields: OfficialBeerExtractedFields = {
    ...fields,
    canonicalUrl: acceptedCanonical
  };
  return {
    match,
    fields: trustedFields,
    productPageUrl: acceptedCanonical || args.pageUrl,
    finalUrl: args.pageUrl
  };
}


/**
 * Deterministic URL-safe slug from a known beer name.
 * Uses foldBeerText for diacritics/punctuation, then hyphenates tokens.
 * Does not fuzzy-correct spelling or invent words.
 */
export function slugifyOfficialBeerName(beerName: string): string {
  const folded = foldBeerText(beerName);
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug;
}

/**
 * Build a tiny bounded set of same-origin product URL candidates.
 * Constructed via the URL API (never raw host concatenation) and capped at 12.
 *
 * The first four candidates always use the primary hyphenated slug. A single
 * compact alternate is then tried as a static-crawl hint before less-common
 * primary prefixes. Page content must still pass exact/strong identity checks.
 */
export function generateOfficialBeerProductUrlCandidates(args: {
  origin: string;
  beerName: string;
}): string[] {
  const slug = slugifyOfficialBeerName(args.beerName);
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return [];

  let originUrl: URL;
  try {
    originUrl = parseSafeHttpUrl(args.origin);
  } catch {
    return [];
  }

  const compactSlug = slug.includes("-") ? slug.replace(/-/g, "") : "";
  const commonPrefixes = OFFICIAL_BEER_PRODUCT_PATH_PREFIXES.slice(0, 4);
  const ordered: Array<{ prefix: string; candidateSlug: string }> = [
    ...commonPrefixes.map((prefix) => ({ prefix, candidateSlug: slug })),
    ...(compactSlug && compactSlug !== slug
      ? commonPrefixes.map((prefix) => ({ prefix, candidateSlug: compactSlug }))
      : []),
    ...OFFICIAL_BEER_PRODUCT_PATH_PREFIXES.slice(4).map((prefix) => ({
      prefix,
      candidateSlug: slug
    }))
  ];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const { prefix, candidateSlug } of ordered) {
    const path = `${prefix}${candidateSlug}/`;
    let candidate: URL;
    try {
      candidate = new URL(path, originUrl);
    } catch {
      continue;
    }
    if (candidate.origin !== originUrl.origin) continue;
    if (candidate.username || candidate.password) continue;
    if (
      !candidate.pathname.includes(`/${candidateSlug}/`)
      && !candidate.pathname.endsWith(`/${candidateSlug}`)
    ) {
      continue;
    }
    // Reject protocol-relative / host-injection attempts.
    if (candidate.pathname.includes("//")) continue;
    const href = candidate.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= 12) break;
  }
  return out;
}

async function tryGuessedOfficialBeerProductUrls(args: {
  input: OfficialBeerDiscoveryInput;
  origin: string;
  domain: string;
  beerName: string;
  breweryName: string;
  ctx: FetchCtx;
  budget: Budget;
}): Promise<{
  matched: EvaluatedPage | null;
  hintUrls: string[];
  jsShellEvidence: boolean;
  guessesTried: number;
}> {
  const candidates = generateOfficialBeerProductUrlCandidates({
    origin: args.origin,
    beerName: args.beerName
  });
  logDiscovery("official_beer_guess_start", {
    domain: args.domain,
    beer: args.beerName,
    candidateCount: candidates.length
  });

  const hintUrls: string[] = [];
  let jsShellEvidence = false;
  let guessesTried = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    if (guessesTried >= MAX_GUESSED_PRODUCT_FETCHES) break;
    if (args.budget.pagesFetched >= args.budget.maxPages) break;
    const candidate = candidates[i]!;
    if (!sameOfficialDomain(candidate, args.domain)) continue;

    let path = candidate;
    try {
      path = new URL(candidate).pathname;
    } catch {
      continue;
    }

    logDiscovery("official_beer_guess_candidate", {
      domain: args.domain,
      path,
      candidateIndex: i + 1,
      beer: args.beerName
    });

    guessesTried += 1;
    const evaluated = await evaluateCandidatePage(
      candidate,
      args.input,
      args.domain,
      args.ctx,
      args.budget
    );
    if (!evaluated) {
      logDiscovery("official_beer_guess_miss", {
        domain: args.domain,
        path,
        candidateIndex: i + 1,
        match: "none"
      });
      continue;
    }

    hintUrls.push(evaluated.finalUrl);
    if (htmlLooksLikeJsAppShell(evaluated.html)) {
      jsShellEvidence = true;
    }

    if (evaluated.match === "exact_name" || evaluated.match === "strong_name") {
      logDiscovery("official_beer_guess_match", {
        domain: args.domain,
        path,
        candidateIndex: i + 1,
        match: evaluated.match,
        beer: args.beerName
      });
      return {
        matched: evaluated,
        hintUrls,
        jsShellEvidence,
        guessesTried
      };
    }

    logDiscovery("official_beer_guess_miss", {
      domain: args.domain,
      path,
      candidateIndex: i + 1,
      match: evaluated.match
    });
  }

  if (guessesTried > 0) {
    logDiscovery("official_beer_guess_exhausted", {
      domain: args.domain,
      beer: args.beerName,
      guessesTried
    });
  }

  return {
    matched: null,
    hintUrls,
    jsShellEvidence,
    guessesTried
  };
}

function defaultSeedIndexUrls(origin: string): string[] {
  return [
    `${origin}/`,
    `${origin}/beers`,
    `${origin}/beer`,
    `${origin}/our-beers`,
    `${origin}/beer-finder`,
    `${origin}/products`
  ];
}

async function tryOfficialBeerBrowserFallback(args: {
  input: OfficialBeerDiscoveryInput;
  domain: string;
  origin: string;
  beerName: string;
  breweryName: string;
  pagesFetched: number;
  hintUrls: string[];
  jsShellEvidence: boolean;
  staticStatus: "unsupported_static_site" | "not_found";
  deps: OfficialBeerDiscoveryDeps;
}): Promise<OfficialBeerDiscoveryResult | null> {
  const enabled =
    args.deps.browserFallbackEnabled ?? isOfficialBeerBrowserConfigured();
  if (!enabled) {
    logDiscovery("official_beer_browser_skip", {
      domain: args.domain,
      reason: "browser_unconfigured"
    });
    return null;
  }
  if (args.staticStatus === "not_found" && !args.jsShellEvidence) {
    logDiscovery("official_beer_browser_skip", {
      domain: args.domain,
      reason: "no_js_shell_evidence"
    });
    return null;
  }

  const render =
    args.deps.renderOfficialPage ??
    ((input) => renderOfficialBreweryBeerPage(input, args.deps.browserDeps));

  const seed = prioritizeUrls(
    [
      ...args.hintUrls,
      ...defaultSeedIndexUrls(args.origin)
    ].filter((url) => sameOfficialDomain(url, args.domain)),
    args.domain,
    args.beerName
  );

  const queue: string[] = [];
  const seen = new Set<string>();
  for (const url of seed) {
    if (seen.has(url)) continue;
    seen.add(url);
    queue.push(url);
    if (queue.length >= 4) break;
  }
  if (queue.length === 0) queue.push(`${args.origin}/`);

  let browserPages = 0;
  let transientFailure = false;

  while (queue.length > 0 && browserPages < OFFICIAL_BEER_BROWSER_MAX_PAGES) {
    const url = queue.shift()!;
    browserPages += 1;
    let outcome: OfficialBeerBrowserOutcome;
    try {
      outcome = await render({
        url,
        breweryName: args.breweryName,
        beerName: args.beerName,
        registeredDomain: args.domain
      });
    } catch (error) {
      transientFailure = true;
      logDiscovery("official_beer_browser_error", {
        domain: args.domain,
        reason: error instanceof Error ? error.message.slice(0, 120) : "error"
      });
      continue;
    }

    if (outcome.status === "timeout" || outcome.status === "error" || outcome.status === "unavailable") {
      if (outcome.status === "timeout" || outcome.status === "error") transientFailure = true;
      continue;
    }
    if (outcome.status === "off_domain" || outcome.status === "invalid_result") {
      continue;
    }
    if (outcome.status !== "ok") {
      continue;
    }

    const page = outcome.page;
    if (!sameOfficialDomain(page.finalUrl, args.domain)) {
      logDiscovery("official_beer_browser_off_domain", { domain: args.domain });
      continue;
    }

    if (page.html && page.html.trim()) {
      const scored = scoreOfficialBeerHtmlPage({
        html: page.html,
        pageUrl: page.finalUrl,
        beerName: args.beerName,
        breweryName: args.breweryName,
        registeredDomain: args.domain
      });
      if (scored && (scored.match === "exact_name" || scored.match === "strong_name")) {
        logDiscovery("official_beer_browser_match", {
          domain: args.domain,
          match: scored.match,
          url: scored.productPageUrl
        });
        return {
          status: "matched",
          match: scored.match,
          productPageUrl: scored.productPageUrl,
          registeredDomain: args.domain,
          fields: {
            ...scored.fields,
            productPageUrl: scored.productPageUrl,
            canonicalUrl: scored.fields.canonicalUrl || scored.productPageUrl
          },
          pagesFetched: args.pagesFetched + browserPages,
          reason: "browser_matched"
        };
      }
    }

    const linkUrls = page.links.map((l: { href: string }) => l.href);
    if (page.html) {
      linkUrls.push(
        ...extractSameDomainLinks(page.html, page.finalUrl, args.domain)
      );
    }
    const ranked = prioritizeUrls(linkUrls, args.domain, args.beerName).slice(0, 6);
    for (const link of ranked) {
      if (seen.has(link)) continue;
      seen.add(link);
      queue.push(link);
    }
  }

  logDiscovery("official_beer_browser_not_found", {
    domain: args.domain,
    browserPages,
    transientFailure
  });
  if (transientFailure) {
    return {
      status: args.staticStatus,
      match: "none",
      productPageUrl: null,
      registeredDomain: args.domain,
      fields: emptyFields(),
      pagesFetched: args.pagesFetched + browserPages,
      reason: "browser_transient_failure"
    };
  }
  return {
    status: args.staticStatus === "unsupported_static_site" ? "unsupported_static_site" : "not_found",
    match: "none",
    productPageUrl: null,
    registeredDomain: args.domain,
    fields: emptyFields(),
    pagesFetched: args.pagesFetched + browserPages,
    reason: "browser_no_strong_match"
  };
}

async function readBodyLimited(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        body.destroy();
        throw new NetworkSafetyError("Response is too large.", "too_large");
      }
      chunks.push(buf);
    }
  } catch (error) {
    body.destroy();
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function defaultFetchHtml(
  url: string,
  opts: {
    maxRedirects: number;
    maxBytes: number;
    timeoutMs: number;
    domain: string;
    lookup?: LookupFn;
    request?: PinnedRequestFn;
  }
): Promise<{ finalUrl: string; html: string; contentType: string }> {
  let current = parseSafeHttpUrl(url);
  if (!hostMatchesDiscoveredDomain(current.hostname, opts.domain)) {
    throw new NetworkSafetyError("URL left the official brewery domain.", "redirect");
  }

  for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
    if (!hostMatchesDiscoveredDomain(current.hostname, opts.domain)) {
      throw new NetworkSafetyError("Redirect left the official brewery domain.", "redirect");
    }

    const response = await fetchSafeHttp(current, {
      timeoutMs: opts.timeoutMs,
      maxRedirects: 0,
      lookup: opts.lookup,
      request: opts.request,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "SmokeyVaultOfficialBeerDiscovery/1.0"
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      response.body.resume();
      if (!location) {
        throw new NetworkSafetyError("The page redirected without a destination.", "redirect");
      }
      if (hop >= opts.maxRedirects) {
        throw new NetworkSafetyError("Too many redirects from that link.", "redirect");
      }
      const next = parseSafeHttpUrl(location, current.href);
      if (!hostMatchesDiscoveredDomain(next.hostname, opts.domain)) {
        throw new NetworkSafetyError("Redirect left the official brewery domain.", "redirect");
      }
      current = next;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.body.resume();
      throw new Error(`http_${response.status}`);
    }

    const contentType = headerValue(response.headers, "content-type").toLowerCase();
    const declaredLength = Number(headerValue(response.headers, "content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
      response.body.destroy();
      throw new NetworkSafetyError("Response is too large.", "too_large");
    }

    const buffer = await readBodyLimited(response.body, opts.maxBytes);
    return {
      finalUrl: current.toString(),
      html: buffer.toString("utf8"),
      contentType
    };
  }
  throw new NetworkSafetyError("Too many redirects from that link.", "redirect");
}

type Budget = { pagesFetched: number; maxPages: number };

type FetchCtx = {
  fetchHtml?: FetchHtmlFn;
  maxRedirects: number;
  maxBytes: number;
  timeoutMs: number;
  domain: string;
  lookup?: LookupFn;
  request?: PinnedRequestFn;
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
      domain: ctx.domain,
      lookup: ctx.lookup,
      request: ctx.request
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

  // Only treat same-registered-domain canonicals as authoritative official URLs.
  const acceptedCanonical =
    fields.canonicalUrl && sameOfficialDomain(fields.canonicalUrl, domain)
      ? fields.canonicalUrl
      : null;
  const trustedFields: OfficialBeerExtractedFields = {
    ...fields,
    canonicalUrl: acceptedCanonical
  };

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
      url: acceptedCanonical || page.finalUrl,
      fields: trustedFields,
      html: page.html,
      finalUrl: page.finalUrl
    };
  }

  return {
    match,
    url: page.finalUrl,
    fields: trustedFields,
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
    domain: originInfo.domain,
    lookup: deps.lookup,
    request: deps.request
  };
  const budget: Budget = { pagesFetched: 0, maxPages };

  logDiscovery("official_beer_discovery_start", {
    brewery: breweryName,
    beer: beerName,
    domain: originInfo.domain
  });

  try {
    // 1) Deterministic same-domain product URL guesses (cheap, bounded).
    const guessed = await tryGuessedOfficialBeerProductUrls({
      input: { ...input, beerName, breweryName },
      origin: originInfo.origin,
      domain: originInfo.domain,
      beerName,
      breweryName,
      ctx,
      budget
    });
    if (
      guessed.matched &&
      (guessed.matched.match === "exact_name" || guessed.matched.match === "strong_name")
    ) {
      const result: OfficialBeerDiscoveryResult = {
        status: "matched",
        match: guessed.matched.match,
        productPageUrl: guessed.matched.url,
        registeredDomain: originInfo.domain,
        fields: {
          ...guessed.matched.fields,
          productPageUrl: guessed.matched.url,
          canonicalUrl: guessed.matched.fields.canonicalUrl || guessed.matched.url
        },
        pagesFetched: budget.pagesFetched,
        reason: "guessed_product_url_matched"
      };
      discoveryCache.set(key, { result, expiresAt: now + POSITIVE_CACHE_TTL_MS });
      return result;
    }

    // Guesses use a separate tiny allotment; keep a full static crawl budget afterward.
    budget.maxPages = budget.pagesFetched + maxPages;

    // 2) Existing sitemap / static crawl.
    const sitemapUrls = await collectSitemapCandidateUrls(
      originInfo.origin,
      originInfo.domain,
      beerName,
      ctx,
      budget
    );

    // Remaining unfetched product-path guesses become high-priority static seeds
    // (still same-domain, still identity-validated) without expanding the guess budget.
    const allGuessCandidates = generateOfficialBeerProductUrlCandidates({
      origin: originInfo.origin,
      beerName
    });
    const remainingGuessSeeds = allGuessCandidates.slice(guessed.guessesTried);

    const seedUrls = [
      ...remainingGuessSeeds,
      ...sitemapUrls,
      `${originInfo.origin}/`,
      `${originInfo.origin}/beers`,
      `${originInfo.origin}/beer`,
      `${originInfo.origin}/our-beers`,
      `${originInfo.origin}/products`
    ];

    const queue: Array<{ url: string; depth: number }> = [];
    const seen = new Set<string>();
    for (const url of allGuessCandidates.slice(0, guessed.guessesTried)) {
      seen.add(url);
    }
    for (const url of seedUrls) {
      if (!sameOfficialDomain(url, originInfo.domain)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push({ url, depth: url === `${originInfo.origin}/` ? 0 : 1 });
    }

    let best: EvaluatedPage | null = null;

    let jsShellEvidence = guessed.jsShellEvidence;
    const hintUrls: string[] = [...guessed.hintUrls];

    while (queue.length > 0 && budget.pagesFetched < budget.maxPages) {
      const next = queue.shift()!;
      const evaluated = await evaluateCandidatePage(
        next.url,
        { ...input, beerName, breweryName },
        originInfo.domain,
        ctx,
        budget
      );
      if (!evaluated) continue;

      if (htmlLooksLikeJsAppShell(evaluated.html)) {
        jsShellEvidence = true;
      }
      hintUrls.push(evaluated.finalUrl);
      const pageLinks = extractSameDomainLinks(
        evaluated.html,
        evaluated.finalUrl,
        originInfo.domain
      );
      hintUrls.push(...pageLinks.slice(0, 8));

      if (evaluated.match === "exact_name" || evaluated.match === "strong_name") {
        best = evaluated;
        if (evaluated.match === "exact_name") break;
      }

      if (next.depth >= maxDepth) continue;
      const links = prioritizeUrls(pageLinks, originInfo.domain, beerName).slice(0, 12);
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
      const staticStatus =
        budget.pagesFetched <= 2 ? "unsupported_static_site" : "not_found";
      const browserResult = await tryOfficialBeerBrowserFallback({
        input: { ...input, beerName, breweryName },
        domain: originInfo.domain,
        origin: originInfo.origin,
        beerName,
        breweryName,
        pagesFetched: budget.pagesFetched,
        hintUrls,
        jsShellEvidence: jsShellEvidence || staticStatus === "unsupported_static_site",
        staticStatus,
        deps
      });
      if (browserResult) {
        if (browserResult.status === "matched") {
          discoveryCache.set(key, {
            result: browserResult,
            expiresAt: now + POSITIVE_CACHE_TTL_MS
          });
          return browserResult;
        }
        // Transient browser failures: do not cache long; return static status.
        if (browserResult.reason === "browser_transient_failure") {
          return {
            ...browserResult,
            status: staticStatus,
            reason: staticStatus
          };
        }
        discoveryCache.set(key, {
          result: browserResult,
          expiresAt: now + NOT_FOUND_CACHE_TTL_MS
        });
        return browserResult;
      }
      const result: OfficialBeerDiscoveryResult = {
        status: staticStatus,
        match: "none",
        productPageUrl: null,
        registeredDomain: originInfo.domain,
        fields: emptyFields(),
        pagesFetched: budget.pagesFetched,
        reason: staticStatus === "unsupported_static_site" ? "unsupported_static_site" : "no_strong_match"
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
