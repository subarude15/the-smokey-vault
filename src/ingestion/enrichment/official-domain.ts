/**
 * Official / authoritative domain discovery for enrichment retrieval.
 * Discovery is per brand/product run — never a global retailer whitelist.
 */
import {
  classifySourceUrl,
  hostLooksLikeBrandDomain,
  type SourceClass
} from "./tasting-notes-sources.js";

const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "co.nz",
  "co.jp",
  "com.br"
]);

/** registered domain for host (example.com / example.co.uk). */
export function registeredDomain(hostOrUrl: string): string | null {
  let host = String(hostOrUrl ?? "").trim().toLowerCase();
  if (!host) return null;
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host || null;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

export function hostMatchesDiscoveredDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

export type OfficialDomainDiscovery = {
  domains: string[];
  /** URLs that contributed to discovery. */
  sourceUrls: string[];
};

/**
 * Discover likely producer/brand registered domains from search hits.
 * Uses brand-in-host matching plus light title/url signals — not title alone.
 */
export function discoverOfficialDomains(
  hits: Array<{ title?: string; url?: string; content?: string }>,
  options: { brand?: string | null; name?: string | null } = {}
): OfficialDomainDiscovery {
  const brand = String(options.brand ?? "").trim();
  const domains = new Set<string>();
  const sourceUrls: string[] = [];

  for (const hit of hits) {
    const url = String(hit.url ?? "").trim();
    if (!url) continue;
    let host: string | null = null;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (!host) continue;

    // Never promote known retailer/UGC hosts to official via discovery.
    const baseClass = classifySourceUrl(url, { brand, name: options.name });
    if (baseClass === "retailer" || baseClass === "ugc") continue;

    const reg = registeredDomain(host);
    if (!reg) continue;

    const brandHost = brand ? hostLooksLikeBrandDomain(host, brand) : false;
    const title = String(hit.title ?? "");
    const content = String(hit.content ?? "");
    const brandCore = brand.replace(/^the\s+/i, "").trim();
    const brandInTitle =
      brandCore.length >= 4
      && new RegExp(brandCore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(title);

    // Prefer host-based brand identity; title alone is insufficient.
    if (brandHost || (baseClass === "official")) {
      domains.add(reg);
      sourceUrls.push(url);
      continue;
    }

    // Structured / site signal: URL path looks like a brand product page and title mentions brand.
    if (
      brandInTitle
      && brandCore.length >= 4
      && (/\b(official|distillery|producer)\b/i.test(`${title} ${content}`)
        || /\/(en-us|en-gb|products?|range|whisk(?:y|ey))\b/i.test(url))
    ) {
      // Still require some host affinity: brand token substring in host.
      if (brand && hostLooksLikeBrandDomain(host, brand)) {
        domains.add(reg);
        sourceUrls.push(url);
      }
    }
  }

  return {
    domains: [...domains],
    sourceUrls: sourceUrls.slice(0, 8)
  };
}

/**
 * Classify a URL, honoring previously discovered official domains for this run.
 * Subdomains of a discovered registered domain count as official.
 */
export function classifySourceUrlWithDiscovery(
  url: string,
  options: {
    brand?: string | null;
    name?: string | null;
    discoveredOfficialDomains?: string[];
  } = {}
): SourceClass {
  const base = classifySourceUrl(url, { brand: options.brand, name: options.name });
  if (base === "retailer" || base === "ugc" || base === "regulatory" || base === "importer") {
    return base;
  }
  if (base === "official") return "official";

  const domains = options.discoveredOfficialDomains ?? [];
  if (!domains.length) return base;

  let host: string | null = null;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return base;
  }
  if (!host) return base;
  if (domains.some((d) => hostMatchesDiscoveredDomain(host!, d))) {
    return "official";
  }
  return base;
}
