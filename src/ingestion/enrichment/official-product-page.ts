/**
 * Official product-page discovery and deterministic ranking for image enrichment.
 *
 * Two-step flow (caller-driven):
 *   A) Broad search discovers brand registered domain(s).
 *   B) Bounded site-scoped search finds the best matching product-detail page.
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
  // Bare locale homepage: /en-us, /en-gb
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
  // Age numerals already known.
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
      // Prefer tokens adjacent to a known product hint (e.g. Caribbean Cask).
      const prev = i > 0 ? normalizeToken(words[i - 1]) : "";
      const next = i + 1 < words.length ? normalizeToken(words[i + 1]) : "";
      const nearProduct =
        productHints.some((h) => h === prev || h === next)
        || (brandCore && (prev === brandCore || next === brandCore));
      if (!nearProduct && !/cask|reserve|finish|batch|edition|collection/i.test(w)) {
        continue;
      }
      // Extra gate for non-expression dictionary: require near-product OR known expression word.
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
 * Build bounded site-scoped product-page queries for discovered brand domains.
 * Uses brand + aliased product tokens (+ optional learned expression tokens).
 * Prefer `site:` operator (SearXNG-compatible); no hardcoded product URLs.
 */
export function buildOfficialProductPageQueries(
  identity: SearchIdentityInput,
  discoveredDomains: string[],
  expansionTokens: string[] = []
): Array<{ domain: string; query: string; label: string }> {
  const tokens = extractSearchTokens(identity);
  const brandLoose = tokens.brandCore || tokens.brand;
  const product = tokens.productTokens.join(" ");
  const productLoose = tokens.productTokensWithAliases.join(" ") || product;
  const expansions = expansionTokens
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter(
      (t) =>
        !productLoose
          .toLowerCase()
          .split(/\s+/)
          .includes(t.toLowerCase())
    );

  const out: Array<{ domain: string; query: string; label: string }> = [];
  const domains = discoveredDomains
    .map((d) => String(d ?? "").trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean)
    .slice(0, MAX_DOMAINS_FOR_PRODUCT_SEARCH);

  for (const domain of domains) {
    const baseParts = [brandLoose, productLoose].filter(Boolean);
    if (baseParts.length) {
      out.push({
        domain,
        query: `site:${domain} ${baseParts.join(" ")}`.replace(/\s+/g, " ").trim(),
        label: "official_product_identity"
      });
    }
    if (expansions.length) {
      const expanded = [brandLoose, productLoose, ...expansions].filter(Boolean);
      const q = `site:${domain} ${expanded.join(" ")}`.replace(/\s+/g, " ").trim();
      if (!out.some((o) => o.query === q)) {
        out.push({
          domain,
          query: q,
          label: "official_product_expanded"
        });
      }
    }
    // UPC within domain when available (bounded).
    if (tokens.upc && out.filter((o) => o.domain === domain).length < MAX_PRODUCT_QUERIES_PER_DOMAIN) {
      out.push({
        domain,
        query: `site:${domain} ${tokens.upc} ${brandLoose}`.replace(/\s+/g, " ").trim(),
        label: "official_product_upc"
      });
    }
  }

  // Cap total queries.
  return out.slice(0, MAX_DOMAINS_FOR_PRODUCT_SEARCH * MAX_PRODUCT_QUERIES_PER_DOMAIN);
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

  // Exact-ish product title: most identity tokens present.
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

  // Weak / negative signals
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
    /** Minimum score to accept as a product page (not merely "least bad homepage"). */
    minScore?: number;
  } = {}
): { hit: OfficialPageHit; score: OfficialProductPageScoreBreakdown } | null {
  const minScore = options.minScore ?? 40;
  const domains = options.discoveredOfficialDomains ?? [];
  let best: { hit: OfficialPageHit; score: OfficialProductPageScoreBreakdown } | null = null;

  for (const hit of hits) {
    const url = String(hit.url ?? "").trim();
    if (!url) continue;
    // Restrict to discovered registered domains when known.
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

export { registeredDomain };
