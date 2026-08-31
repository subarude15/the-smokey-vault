/**
 * Image source classification for product-image enrichment.
 * Reuses retailer/UGC denylists aligned with tasting-note sourcing.
 */
/**
 * Image source classification for product-image enrichment.
 * Reuses retailer/UGC denylists aligned with tasting-note sourcing.
 */
import { classifySourceUrlWithDiscovery } from "./official-domain.js";
import type { SourceClass } from "./tasting-notes-sources.js";

export type ImageSourceType = "user" | "official" | "licensed" | "approved" | "lookup" | "unknown";

/** Hosts treated as clearly licensed / open imagery. */
const LICENSED_HOST_FRAGMENTS = [
  "openfoodfacts.org",
  "openfoodfacts",
  "wikimedia.org",
  "wikipedia.org",
  "upload.wikimedia.org",
  "creativecommons.org"
] as const;

/** Explicitly approved catalog / CDN hosts (not retailers). */
const APPROVED_HOST_FRAGMENTS = [
  "colacloud",
  "cloudfront.net",
  "upcitemdb",
  "finewineandgoodspirits.com",
  "demandware.net",
  "scene7.com",
  "brewfather.app"
] as const;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostMatches(host: string, fragments: readonly string[]): boolean {
  return fragments.some((frag) => host.includes(frag));
}

/**
 * Map an image URL (+ optional page URL) to an enrichment source type.
 * Retailer / UGC / unknown are not acceptable for auto-accept.
 */
export function classifyImageSource(
  imageUrl: string,
  options: {
    brand?: string | null;
    name?: string | null;
    pageUrl?: string | null;
    discoveredOfficialDomains?: string[];
  } = {}
): ImageSourceType {
  const host = hostOf(imageUrl);
  if (!host) return "unknown";

  if (hostMatches(host, LICENSED_HOST_FRAGMENTS)) return "licensed";
  if (hostMatches(host, APPROVED_HOST_FRAGMENTS)) return "approved";

  const pageClass: SourceClass = classifySourceUrlWithDiscovery(options.pageUrl || imageUrl, {
    brand: options.brand,
    name: options.name,
    discoveredOfficialDomains: options.discoveredOfficialDomains
  });
  if (pageClass === "official") return "official";
  if (pageClass === "retailer" || pageClass === "ugc") return "unknown";

  // Brand token in image host itself.
  const brandClass = classifySourceUrlWithDiscovery(imageUrl, {
    brand: options.brand,
    name: options.name,
    discoveredOfficialDomains: options.discoveredOfficialDomains
  });
  if (brandClass === "official") return "official";

  return "unknown";
}

export function isAcceptableImageSource(sourceType: ImageSourceType): boolean {
  return sourceType === "official" || sourceType === "licensed" || sourceType === "approved" || sourceType === "user";
}
