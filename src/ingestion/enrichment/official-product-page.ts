/**
 * Official product-page discovery and deterministic ranking for image enrichment.
 *
 * Flow (caller-driven):
 *   A) Broad search discovers brand registered domain(s).
 *   B) Optional site:-scoped queries (may return zero on some SearXNG engines).
 *   C) Broad-search fallback + code-side registered-domain filter.
 *   D) Bounded same-domain sitemap / homepage-link discovery when search still empty.
 *
 * Ranking is rule-based — never LLM-assigned. Subdomain trust uses registered-domain
 * relationship (shop.us.example.com under example.com). CDN hosts stay untrusted
 * unless referenced by a selected official product page (page-scoped provenance).
 */
import {
  brandCoreToken,
  extractSearchTokens,
  type SearchIdentityInput
} from "./search-query.js";
import { hostMatchesDiscoveredDomain, registeredDomain } from "./official-domain.js";
import { safeImageUrlParts } from "./image-candidate-diagnostics.js";

export type OfficialPageHit = {
  title?: string;
  content?: string;
  url: string;
};

export type OfficialProductPageScoreBreakdown = {
  total: number;
  reasons: string[];
};

export type OfficialProductQuery = {
  query: string;
  label: string;
  /** Present for optional site:-scoped tiers only. */
  domain?: string;
};

const GENERIC_PATH_RE =
  /^\/(?:en(?:-[a-z]{2})?|us|uk|eu|global)?\/?$/i;
const NEGATIVE_PATH_RE =
  /\/(?:press|news|media|blog|legal|privacy|terms|cookies?|disclaimer|regulatory|age-gate|agegate|country(?:-select(?:ion)?)?|select-country|locations?|careers?|about(?:-us)?|contact|faq|help|support)(?:\/|$)/i;
const COLLECTION_ONLY_RE =
  /\/(?:collections?|range|whisk(?:y|ey)|spirits?)\/?$/i;
const PRODUCT_PATH_RE =
  /\/(?:products?|p)\/[a-z0-9][\w-]{2,}/i;
const RANGE_PRODUCT_RE =
  /\/(?:range|whisk(?:y|ey)|spirits?)\/[a-z0-9][\w-]{3,}/i;

const MAX_PRODUCT_QUERIES_PER_DOMAIN = 2;
const MAX_DOMAINS_FOR_PRODUCT_SEARCH = 2;
const MAX_BROAD_PRODUCT_QUERIES = 4;
const MAX_SITEMAP_HOSTS = 3;
const MAX_SITEMAP_FETCHES = 4;
const MAX_SITEMAP_URLS_SCANNED = 80;
const MAX_SITEMAP_BYTES = 400_000;
const SITEMAP_TIMEOUT_MS = 6_000;

function normalizeToken(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function tokenize(value: string): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function cleanQuery(parts: Array<string | null | undefined>): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compact preferred product phrase for retrieval (aliases applied; no duplicate Yr+Year). */
export function preferredProductPhrase(identity: SearchIdentityInput): string {
  const tokens = extractSearchTokens(identity);
  return tokens.productTokens.join(" ");
}

/** Pathname without trailing slash (keep root as "/"). */
export function pagePathname(url: string): string {
  try {
    const path = new URL(url).pathname || "/";
    if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
    return path;
  } catch {
    return "";
  }
}

/**
 * True when the URL looks like a generic brand/landing/legal page rather than
 * a product-detail page. Used to avoid early-stopping image discovery.
 */
export function isGenericOfficialPageUrl(url: string): boolean {
  const path = pagePathname(url);
  if (!path || path === "/") return true;
  if (GENERIC_PATH_RE.test(path)) return true;
  if (NEGATIVE_PATH_RE.test(path)) return true;
  if (COLLECTION_ONLY_RE.test(path)) return true;
  if (/^\/[a-z]{2}(?:-[a-z]{2})?$/i.test(path)) return true;
  return false;
}

/** Strong product-detail path signals (/products/slug, /range/expression, …). */
export function isProductDetailPageUrl(url: string): boolean {
  const path = pagePathname(url);
  if (!path || isGenericOfficialPageUrl(url)) return false;
  if (PRODUCT_PATH_RE.test(path)) return true;
  if (RANGE_PRODUCT_RE.test(path)) return true;
  return false;
}

/**
 * Learn distinctive expression tokens from search titles/snippets only.
 * Example: stored "Carribbean" + title "Caribbean Cask 14" → learn "Cask".
 * Never invents tokens from model knowledge; never mutates canonical identity.
 */
export function extractExpressionTokensFromHits(
  hits: OfficialPageHit[],
  identity: SearchIdentityInput
): string[] {
  const tokens = extractSearchTokens(identity);
  const known = new Set(
    [
      ...tokens.productTokens,
      ...tokens.productTokensWithAliases,
      tokens.brandCore,
      brandCoreToken(tokens.brand)
    ]
      .flatMap((t) => tokenize(t))
      .map(normalizeToken)
      .filter(Boolean)
  );
  for (const t of tokens.productTokens) {
    if (/^\d+$/.test(t)) known.add(t);
  }

  const learned = new Map<string, number>();
  const brandCore = normalizeToken(tokens.brandCore || tokens.brand);
  const productHints = tokens.productTokensWithAliases
    .map(normalizeToken)
    .filter((t) => t.length >= 4);

  for (const hit of hits) {
    const hay = `${hit.title ?? ""} ${hit.content ?? ""} ${hit.url}`;
    const words = tokenize(hay);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const norm = normalizeToken(w);
      if (norm.length < 3 || norm.length > 24) continue;
      if (known.has(norm)) continue;
      if (/^\d+$/.test(norm)) continue;
      if (
        [
          "official",
          "website",
          "whisky",
          "whiskey",
          "scotch",
          "single",
          "malt",
          "buy",
          "shop",
          "store",
          "home",
          "volume",
          "delivery",
          "year",
          "years",
          "old",
          "the"
        ].includes(norm)
      ) {
        continue;
      }
      const prev = i > 0 ? normalizeToken(words[i - 1]) : "";
      const next = i + 1 < words.length ? normalizeToken(words[i + 1]) : "";
      const nearProduct =
        productHints.some((h) => h === prev || h === next)
        || (brandCore && (prev === brandCore || next === brandCore));
      if (!nearProduct && !/cask|reserve|finish|batch|edition|collection/i.test(w)) {
        continue;
      }
      if (!nearProduct && !/^(cask|reserve|finish|batch|edition)$/i.test(w)) continue;
      learned.set(w, (learned.get(w) ?? 0) + (nearProduct ? 2 : 1));
    }
  }

  return [...learned.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Optional site:-scoped product-page queries (may return zero on some SearXNG engines).
 * Prefer preferred product tokens (not Yr+Year duplicates).
 */
export function buildOfficialProductPageQueries(
  identity: SearchIdentityInput,
  discoveredDomains: string[],
  expansionTokens: string[] = []
): OfficialProductQuery[] {
  const tokens = extractSearchTokens(identity);
  const brandLoose = tokens.brandCore || tokens.brand;
  const product = preferredProductPhrase(identity);
  const expansions = expansionTokens
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter(
      (t) =>
        !product
          .toLowerCase()
          .split(/\s+/)
          .includes(t.toLowerCase())
    );

  const out: OfficialProductQuery[] = [];
  const domains = discoveredDomains
    .map((d) => String(d ?? "").trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean)
    .slice(0, MAX_DOMAINS_FOR_PRODUCT_SEARCH);

  for (const domain of domains) {
    const base = cleanQuery([brandLoose, product]);
    if (base) {
      out.push({
        domain,
        query: `site:${domain} ${base}`,
        label: "official_product_identity"
      });
    }
    if (expansions.length) {
      const expanded = cleanQuery([brandLoose, product, ...expansions]);
      const q = `site:${domain} ${expanded}`;
      if (!out.some((o) => o.query === q)) {
        out.push({
          domain,
          query: q,
          label: "official_product_expanded"
        });
      }
    }
    if (tokens.upc && out.filter((o) => o.domain === domain).length < MAX_PRODUCT_QUERIES_PER_DOMAIN) {
      out.push({
        domain,
        query: cleanQuery([`site:${domain}`, tokens.upc, brandLoose]),
        label: "official_product_upc"
      });
    }
  }

  return out.slice(0, MAX_DOMAINS_FOR_PRODUCT_SEARCH * MAX_PRODUCT_QUERIES_PER_DOMAIN);
}

/**
 * Broad (non-site:) product-page queries. Code-side domain filtering happens after.
 * Uses preferred tokens + optional learned expression tokens (e.g. Cask).
 */
export function buildOfficialProductPageBroadQueries(
  identity: SearchIdentityInput,
  expansionTokens: string[] = []
): OfficialProductQuery[] {
  const tokens = extractSearchTokens(identity);
  const brandLoose = tokens.brandCore || tokens.brand;
  const brandFull = tokens.brand || brandLoose;
  const product = preferredProductPhrase(identity);
  const expansions = expansionTokens
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter((t) => !product.toLowerCase().split(/\s+/).includes(t.toLowerCase()));

  const out: OfficialProductQuery[] = [];
  const push = (label: string, parts: Array<string | null | undefined>) => {
    const query = cleanQuery(parts);
    if (!query) return;
    if (out.some((o) => o.query.toLowerCase() === query.toLowerCase())) return;
    out.push({ query, label });
  };

  push("broad_product_identity", [brandLoose, product]);
  if (brandFull && brandFull.toLowerCase() !== brandLoose.toLowerCase()) {
    push("broad_product_brand_full", [brandFull, product, ...expansions]);
  }
  if (expansions.length) {
    push("broad_product_expanded", [brandLoose, product, ...expansions]);
    push("broad_product_expanded_product", [brandLoose, product, ...expansions, "product"]);
  } else {
    push("broad_product_keyword", [brandLoose, product, "product"]);
  }
  const age = tokens.productTokens.find((t) => /^\d+$/.test(t));
  const withoutYearWord = tokens.productTokens.filter(
    (t) => !/^(year|years|old)$/i.test(t)
  );
  if (age && withoutYearWord.join(" ") !== product) {
    push("broad_product_age_compact", [brandLoose, ...withoutYearWord]);
  }

  return out.slice(0, MAX_BROAD_PRODUCT_QUERIES);
}

/**
 * Keep only hits whose registered domain matches a trusted discovered domain.
 * Retailers / fan sites with brand-like names are rejected here.
 */
export function filterHitsByOfficialRegisteredDomain(
  hits: OfficialPageHit[],
  trustedDomains: string[]
): OfficialPageHit[] {
  const trusted = trustedDomains
    .map((d) => String(d ?? "").trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  if (!trusted.length) return [];
  const out: OfficialPageHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const url = String(hit.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!trusted.some((d) => hostMatchesDiscoveredDomain(host, d))) continue;
    seen.add(url);
    out.push(hit);
  }
  return out;
}

function pathTokenMatches(path: string, identityTokens: string[]): number {
  const pathNorm = normalizeToken(path);
  let hits = 0;
  for (const tok of identityTokens) {
    const n = normalizeToken(tok);
    if (n.length >= 3 && pathNorm.includes(n)) hits += 1;
  }
  return hits;
}

function titleTokenMatches(title: string, identityTokens: string[]): number {
  const titleNorm = normalizeToken(title);
  let hits = 0;
  for (const tok of identityTokens) {
    const n = normalizeToken(tok);
    if (n.length >= 3 && titleNorm.includes(n)) hits += 1;
  }
  return hits;
}

/**
 * Deterministic product-page quality score for ranking authoritative URLs.
 * Higher is better. Never uses an LLM.
 */
export function scoreOfficialProductPage(
  hit: OfficialPageHit,
  identity: SearchIdentityInput,
  options: {
    discoveredOfficialDomains?: string[];
    htmlSignals?: {
      hasJsonLdProduct?: boolean;
      ogTypeProduct?: boolean;
      gtinMatch?: boolean;
      hasPriceOrVariant?: boolean;
      productName?: string | null;
    };
  } = {}
): OfficialProductPageScoreBreakdown {
  const reasons: string[] = [];
  let total = 0;
  const url = String(hit.url ?? "").trim();
  if (!url) return { total: -1000, reasons: ["missing_url"] };

  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { total: -1000, reasons: ["bad_url"] };
  }

  const domains = options.discoveredOfficialDomains ?? [];
  const onOfficialDomain =
    domains.length === 0
    || domains.some((d) => hostMatchesDiscoveredDomain(host, d));
  if (!onOfficialDomain) {
    return { total: -500, reasons: ["off_discovered_domain"] };
  }

  const tokens = extractSearchTokens(identity);
  const identityTokens = [
    ...tokens.productTokensWithAliases,
    ...tokens.productTokens,
    tokens.brandCore
  ].filter(Boolean);
  const path = pagePathname(url);
  const title = String(hit.title ?? "");
  const content = String(hit.content ?? "");
  const hay = `${title} ${content}`;

  if (PRODUCT_PATH_RE.test(path)) {
    total += 80;
    reasons.push("products_path");
  } else if (RANGE_PRODUCT_RE.test(path)) {
    total += 55;
    reasons.push("range_product_path");
  }

  const pathHits = pathTokenMatches(path, identityTokens);
  if (pathHits) {
    total += Math.min(40, pathHits * 12);
    reasons.push(`path_tokens:${pathHits}`);
  }

  const titleHits = titleTokenMatches(title || hay, identityTokens);
  if (titleHits) {
    total += Math.min(35, titleHits * 10);
    reasons.push(`title_tokens:${titleHits}`);
  }

  const needed = tokens.productTokens.filter((t) => normalizeToken(t).length >= 3);
  if (needed.length >= 2) {
    const matched = needed.filter((t) =>
      normalizeToken(title).includes(normalizeToken(t))
      || normalizeToken(path).includes(normalizeToken(t))
    );
    if (matched.length === needed.length) {
      total += 25;
      reasons.push("exact_identity_tokens");
    }
  }

  if (/\b\d+\s*(?:yr|year)/i.test(hay) || /\/\d{1,2}(?:-year)?/i.test(path)) {
    total += 8;
    reasons.push("age_signal");
  }

  if (tokens.upc && (hay.includes(tokens.upc) || path.includes(tokens.upc))) {
    total += 30;
    reasons.push("upc_match");
  }

  const html = options.htmlSignals;
  if (html?.hasJsonLdProduct) {
    total += 35;
    reasons.push("json_ld_product");
  }
  if (html?.ogTypeProduct) {
    total += 20;
    reasons.push("og_type_product");
  }
  if (html?.gtinMatch) {
    total += 40;
    reasons.push("gtin_match");
  }
  if (html?.hasPriceOrVariant) {
    total += 12;
    reasons.push("price_or_variant");
  }
  if (html?.productName) {
    const nameHits = titleTokenMatches(html.productName, identityTokens);
    if (nameHits >= 2) {
      total += 15;
      reasons.push("html_product_name");
    }
  }

  if (isGenericOfficialPageUrl(url)) {
    total -= 60;
    reasons.push("generic_official_page");
  }
  if (NEGATIVE_PATH_RE.test(path)) {
    total -= 80;
    reasons.push("negative_path");
  }
  if (COLLECTION_ONLY_RE.test(path)) {
    total -= 25;
    reasons.push("collection_landing");
  }
  if (path === "/" || GENERIC_PATH_RE.test(path)) {
    total -= 40;
    reasons.push("homepage");
  }

  return { total, reasons };
}

/**
 * Pick the best official product-detail page from search hits.
 * Returns null when nothing clears a minimal product-page bar.
 */
export function selectBestOfficialProductPage(
  hits: OfficialPageHit[],
  identity: SearchIdentityInput,
  options: {
    discoveredOfficialDomains?: string[];
    minScore?: number;
  } = {}
): { hit: OfficialPageHit; score: OfficialProductPageScoreBreakdown } | null {
  const minScore = options.minScore ?? 40;
  const domains = options.discoveredOfficialDomains ?? [];
  let best: { hit: OfficialPageHit; score: OfficialProductPageScoreBreakdown } | null = null;

  for (const hit of hits) {
    const url = String(hit.url ?? "").trim();
    if (!url) continue;
    if (domains.length) {
      let host = "";
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (!domains.some((d) => hostMatchesDiscoveredDomain(host, d))) continue;
    }
    const score = scoreOfficialProductPage(hit, identity, {
      discoveredOfficialDomains: domains
    });
    if (score.total < minScore) continue;
    if (!best || score.total > best.score.total) {
      best = { hit, score };
    }
  }
  return best;
}

/** True when at least one hit looks like a product-detail page on a discovered domain. */
export function hasOfficialProductDetailHit(
  hits: OfficialPageHit[],
  discoveredDomains: string[],
  identity: SearchIdentityInput
): boolean {
  return selectBestOfficialProductPage(hits, identity, {
    discoveredOfficialDomains: discoveredDomains,
    minScore: 40
  }) != null;
}

/** Safe host+path display for diagnostics. */
export function safeOfficialPageDisplay(url: string): string {
  const parts = safeImageUrlParts(url);
  if (parts.host) {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 64 ? `${u.pathname.slice(0, 61)}…` : u.pathname;
      return `${u.host}${path}`.slice(0, 160);
    } catch {
      return parts.display.slice(0, 160);
    }
  }
  return String(url ?? "").slice(0, 160);
}

/** Host is under a discovered official registered domain (incl. commerce subdomains). */
export function hostIsUnderOfficialDomain(
  urlOrHost: string,
  discoveredDomains: string[]
): boolean {
  let host = String(urlOrHost ?? "").trim().toLowerCase();
  if (!host) return false;
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^www\./, "");
  return discoveredDomains.some((d) => hostMatchesDiscoveredDomain(host, d));
}

function absolutizeSameDomain(raw: string, baseUrl: string, trustedDomains: string[]): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("#")) return null;
  try {
    const abs = new URL(value, baseUrl).toString();
    if (!/^https?:\/\//i.test(abs)) return null;
    if (!hostIsUnderOfficialDomain(abs, trustedDomains)) return null;
    return abs;
  } catch {
    return null;
  }
}

async function fetchBoundedText(
  url: string,
  fetchFn: typeof fetch,
  maxBytes = MAX_SITEMAP_BYTES
): Promise<string | null> {
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
      headers: { Accept: "application/xml,text/xml,text/plain,*/*;q=0.1" },
      redirect: "follow"
    });
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    const slice = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
    return slice.toString("utf8");
  } catch {
    return null;
  }
}

function extractUrlsFromXml(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const u = String(m[1] ?? "").trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function extractSitemapHintsFromRobots(robots: string): string[] {
  const out: string[] = [];
  for (const line of String(robots ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

function extractSameDomainLinks(html: string, pageUrl: string, trustedDomains: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])([^"']+)\1/gi)) {
    const abs = absolutizeSameDomain(m[2], pageUrl, trustedDomains);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 40) break;
  }
  return out;
}

export type OfficialSitemapDiscoveryResult = {
  urls: OfficialPageHit[];
  hostsTried: string[];
  sitemapsFetched: number;
  reason: string;
};

/**
 * Bounded same-domain discovery via robots/sitemap/homepage links.
 * Never crawls the whole site; never authorizes off-domain URLs.
 */
export async function discoverOfficialProductUrlsFromSite(options: {
  trustedDomains: string[];
  knownHosts?: string[];
  identity: SearchIdentityInput;
  fetchText?: (url: string) => Promise<string | null>;
}): Promise<OfficialSitemapDiscoveryResult> {
  const trusted = options.trustedDomains
    .map((d) => String(d ?? "").trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean)
    .slice(0, MAX_DOMAINS_FOR_PRODUCT_SEARCH);
  if (!trusted.length) {
    return { urls: [], hostsTried: [], sitemapsFetched: 0, reason: "no_trusted_domain" };
  }

  const fetchText = options.fetchText ?? ((url: string) => fetchBoundedText(url, fetch));
  const hosts = new Set<string>();
  for (const d of trusted) {
    hosts.add(d);
    hosts.add(`www.${d}`);
  }
  for (const raw of options.knownHosts ?? []) {
    const h = String(raw ?? "").trim().toLowerCase().replace(/^www\./, "");
    if (!h) continue;
    if (trusted.some((d) => hostMatchesDiscoveredDomain(h, d))) hosts.add(h);
  }

  const hostsTried = [...hosts].slice(0, MAX_SITEMAP_HOSTS);
  const candidateUrls: string[] = [];
  const seen = new Set<string>();
  let sitemapsFetched = 0;

  const pushUrl = (url: string) => {
    const u = String(url ?? "").trim();
    if (!u || seen.has(u)) return;
    if (!hostIsUnderOfficialDomain(u, trusted)) return;
    seen.add(u);
    candidateUrls.push(u);
  };

  for (const host of hostsTried) {
    if (sitemapsFetched >= MAX_SITEMAP_FETCHES) break;
    const origin = `https://${host}`;
    const robots = await fetchText(`${origin}/robots.txt`);
    const sitemapHints = robots ? extractSitemapHintsFromRobots(robots) : [];
    const sitemapSeeds = [
      ...sitemapHints,
      `${origin}/sitemap.xml`,
      `${origin}/sitemap_products_1.xml`,
      `${origin}/product-sitemap.xml`
    ];
    for (const sm of [...new Set(sitemapSeeds)]) {
      if (sitemapsFetched >= MAX_SITEMAP_FETCHES) break;
      if (!hostIsUnderOfficialDomain(sm, trusted)) continue;
      const xml = await fetchText(sm);
      sitemapsFetched += 1;
      if (!xml) continue;
      const locs = extractUrlsFromXml(xml);
      const nested = locs.filter((u) => /sitemap/i.test(u)).slice(0, 2);
      for (const nest of nested) {
        if (sitemapsFetched >= MAX_SITEMAP_FETCHES) break;
        if (!hostIsUnderOfficialDomain(nest, trusted)) continue;
        const nestedXml = await fetchText(nest);
        sitemapsFetched += 1;
        if (!nestedXml) continue;
        for (const u of extractUrlsFromXml(nestedXml).slice(0, MAX_SITEMAP_URLS_SCANNED)) {
          pushUrl(u);
        }
      }
      for (const u of locs.slice(0, MAX_SITEMAP_URLS_SCANNED)) {
        if (/sitemap/i.test(u) && !PRODUCT_PATH_RE.test(u)) continue;
        pushUrl(u);
      }
    }

    const homeHtml = await fetchText(`${origin}/`);
    if (homeHtml) {
      for (const link of extractSameDomainLinks(homeHtml, `${origin}/`, trusted)) {
        pushUrl(link);
      }
    }
  }

  const hits: OfficialPageHit[] = candidateUrls
    .filter((u) => isProductDetailPageUrl(u) || PRODUCT_PATH_RE.test(pagePathname(u)))
    .slice(0, MAX_SITEMAP_URLS_SCANNED)
    .map((url) => ({ url, title: pagePathname(url), content: "sitemap_or_nav" }));

  const ranked = selectBestOfficialProductPage(hits, options.identity, {
    discoveredOfficialDomains: trusted,
    minScore: 40
  });

  return {
    urls: ranked ? [ranked.hit] : hits.slice(0, 5),
    hostsTried,
    sitemapsFetched,
    reason: ranked
      ? `matched:${safeOfficialPageDisplay(ranked.hit.url)}`
      : hits.length
        ? "urls_found_none_ranked"
        : "no_matching_product_urls"
  };
}

export { registeredDomain };
