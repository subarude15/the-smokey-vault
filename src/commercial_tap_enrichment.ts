/**
 * PR125 — Commercial draft-tap beer identity + imagery enrichment.
 *
 * Reuses official packaged-beer discovery under strict exact/strong identity.
 * Fill-missing only: never overwrite Keeper-entered style/ABV/image/notes.
 * Homebrew / Brewfather-linked taps are excluded.
 */
import { beerTextTokens, foldBeerText, parseBeerQuery } from "./beer_search_query.js";
import { isTapEmpty } from "./catalog.js";
import { db } from "./db.js";
import { localizeImage, type LocalizeImageDeps } from "./images.js";
import { getEnrichmentSource, upsertEnrichmentSource } from "./ingestion/jobs/enrichment-sources.js";
import {
  discoverOfficialBeerProductPage,
  extractOfficialBeerImageCandidates,
  isOfficialBreweryDiscoveryEnabled,
  isRejectedOfficialImageCandidate,
  type OfficialBeerDiscoveryDeps,
  type OfficialBeerDiscoveryResult,
  type OfficialBeerPageMatch
} from "./official_brewery_beer_discovery.js";
import { resolveBreweryHints } from "./open_brewery_db.js";

export const COMMERCIAL_TAP_ENTITY_TYPE = "taps" as const;
export const COMMERCIAL_TAP_JOB_TYPE = "commercial_beer" as const;

export type CommercialTapImageKind =
  | "keeper"
  | "product"
  | "beer_logo"
  | "brewery_logo"
  | "none";

export type CommercialTapEnrichmentStatus =
  | "matched"
  | "no_result"
  | "skipped_homebrew"
  | "skipped_empty"
  | "skipped_incomplete_identity"
  | "disabled"
  | "error";

export type CommercialTapEnrichmentResult = {
  status: CommercialTapEnrichmentStatus;
  match: OfficialBeerPageMatch | "none";
  reason: string;
  productPageUrl: string | null;
  updatedFields: string[];
  preservedFields: string[];
  imageKind: CommercialTapImageKind;
  discovery: OfficialBeerDiscoveryResult | null;
};

export type CommercialTapEnrichmentDeps = {
  discoveryDeps?: OfficialBeerDiscoveryDeps;
  localizeImageDeps?: LocalizeImageDeps;
  /** Optional HTML fetcher for logo fallback pages (defaults to discovery fetchHtml). */
  fetchHtml?: OfficialBeerDiscoveryDeps["fetchHtml"];
  resolveWebsite?: (args: {
    breweryName: string;
    beerName: string;
    tapId: number;
  }) => Promise<{ websiteUrl: string | null; websiteHost: string | null }>;
};

const ACCEPTED_MATCHES = new Set<OfficialBeerPageMatch>(["exact_name", "strong_name"]);

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function isCommercialTap(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const source = text(row.source_type) || "Commercial";
  return !/^homebrew$/i.test(source);
}

export function loadTapRow(tapId: number): Record<string, unknown> | null {
  if (!Number.isFinite(tapId) || tapId <= 0) return null;
  const row = db.prepare("SELECT * FROM taps WHERE id = ?").get(tapId) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

export async function resolveCommercialTapBreweryWebsite(args: {
  breweryName: string;
  beerName: string;
  tapId: number;
}): Promise<{ websiteUrl: string | null; websiteHost: string | null }> {
  const stored = getEnrichmentSource(
    COMMERCIAL_TAP_ENTITY_TYPE,
    args.tapId,
    "official_brewery_domain"
  );
  if (stored?.sourceUrl) {
    try {
      const host = new URL(stored.sourceUrl).hostname.replace(/^www\./, "");
      return { websiteUrl: stored.sourceUrl, websiteHost: host || null };
    } catch {
      const host = stored.sourceUrl
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./, "")
        .split("/")[0];
      return { websiteUrl: stored.sourceUrl, websiteHost: host || null };
    }
  }

  try {
    const parsed = parseBeerQuery(`${args.breweryName} ${args.beerName}`.trim());
    const hints = await resolveBreweryHints({
      parsed,
      candidateBreweries: [args.breweryName]
    });
    const hit = hints[0];
    if (!hit) return { websiteUrl: null, websiteHost: null };
    return {
      websiteUrl: hit.websiteUrl ?? null,
      websiteHost: hit.websiteHost ?? null
    };
  } catch {
    return { websiteUrl: null, websiteHost: null };
  }
}

function styleIsEmpty(value: unknown): boolean {
  return !text(value);
}

function abvIsEmpty(value: unknown): boolean {
  return num(value) <= 0;
}

function imageIsEmpty(value: unknown): boolean {
  return !text(value);
}

function absolutize(raw: string, pageUrl: string): string | null {
  try {
    return new URL(raw, pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * Logo/wordmark fallbacks intentionally accept images the product extractor rejects.
 * Only used after exact/strong beer identity is already established.
 */
export function extractOfficialLogoFallbackCandidates(args: {
  html: string;
  pageUrl: string;
  beerName: string;
  breweryName: string;
}): { beerLogo: string | null; breweryLogo: string | null } {
  const beerFold = foldBeerText(args.beerName);
  const breweryFold = foldBeerText(args.breweryName);
  const beerTokens = beerTextTokens(args.beerName).filter((t) => t.length >= 3);
  const breweryTokens = beerTextTokens(args.breweryName).filter((t) => t.length >= 3);

  let beerLogo: string | null = null;
  let breweryLogo: string | null = null;

  const imgRe = /<img\b[^>]*>/gi;
  let img: RegExpExecArray | null;
  while ((img = imgRe.exec(args.html))) {
    const tag = img[0];
    const src =
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ||
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ||
      null;
    if (!src) continue;
    const abs = absolutize(src, args.pageUrl);
    if (!abs) continue;
    const lower = abs.toLowerCase();
    if (
      lower.startsWith("data:") ||
      lower.startsWith("blob:") ||
      lower.startsWith("javascript:") ||
      /favicon|sprite|pixel|1x1|spacer|tracking/i.test(lower)
    ) {
      continue;
    }
    // Prefer true logo/wordmark assets; skip ordinary product renders here.
    if (!/(?:logo|wordmark|brand-mark|beer-mark)/i.test(lower) && !/(?:logo|wordmark)/i.test(tag)) {
      continue;
    }
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "";
    const altFold = foldBeerText(alt);
    const beerHit =
      (beerFold && (altFold.includes(beerFold) || lower.includes(beerFold.replace(/\s+/g, "")))) ||
      beerTokens.some((t) => altFold.includes(t) || lower.includes(t));
    const breweryHit =
      (breweryFold &&
        (altFold.includes(breweryFold) || lower.includes(breweryFold.replace(/\s+/g, "")))) ||
      breweryTokens.some((t) => altFold.includes(t) || lower.includes(t));

    if (beerHit && !beerLogo) beerLogo = abs;
    else if (breweryHit && !breweryLogo) breweryLogo = abs;
    else if (!beerLogo && !breweryLogo && /logo|wordmark/i.test(lower)) {
      // Last-resort page logo once identity is already exact/strong.
      breweryLogo = abs;
    }
  }

  return { beerLogo, breweryLogo };
}

async function resolveImageForTap(options: {
  discovery: OfficialBeerDiscoveryResult;
  breweryName: string;
  beerName: string;
  websiteUrl: string | null;
  deps: CommercialTapEnrichmentDeps;
}): Promise<{ url: string | null; kind: CommercialTapImageKind }> {
  const productUrl = options.discovery.fields.imageUrl?.trim() || null;
  if (productUrl && !isRejectedOfficialImageCandidate(productUrl)) {
    return { url: productUrl, kind: "product" };
  }

  const fetchHtml =
    options.deps.fetchHtml ||
    options.deps.discoveryDeps?.fetchHtml ||
    null;
  if (!fetchHtml || !options.discovery.productPageUrl) {
    return { url: null, kind: "none" };
  }

  try {
    const page = await fetchHtml(options.discovery.productPageUrl);
    const logos = extractOfficialLogoFallbackCandidates({
      html: page.html,
      pageUrl: page.finalUrl || options.discovery.productPageUrl,
      beerName: options.beerName,
      breweryName: options.breweryName
    });
    if (logos.beerLogo) return { url: logos.beerLogo, kind: "beer_logo" };

    // Product-page DOM may still have a usable product candidate if JSON-LD/og missed it.
    const candidates = extractOfficialBeerImageCandidates({
      html: page.html,
      pageUrl: page.finalUrl || options.discovery.productPageUrl,
      beerName: options.beerName
    });
    if (candidates[0]) return { url: candidates[0], kind: "product" };
    if (logos.breweryLogo) return { url: logos.breweryLogo, kind: "brewery_logo" };
  } catch {
    // Fall through to brewery homepage.
  }

  const origin = options.websiteUrl;
  if (!origin) return { url: null, kind: "none" };
  try {
    const home = await fetchHtml(origin);
    const logos = extractOfficialLogoFallbackCandidates({
      html: home.html,
      pageUrl: home.finalUrl || origin,
      beerName: options.beerName,
      breweryName: options.breweryName
    });
    if (logos.beerLogo) return { url: logos.beerLogo, kind: "beer_logo" };
    if (logos.breweryLogo) return { url: logos.breweryLogo, kind: "brewery_logo" };
  } catch {
    // no logo fallback
  }
  return { url: null, kind: "none" };
}

function emptyResult(
  status: CommercialTapEnrichmentStatus,
  reason: string,
  extras: Partial<CommercialTapEnrichmentResult> = {}
): CommercialTapEnrichmentResult {
  return {
    status,
    match: "none",
    reason,
    productPageUrl: null,
    updatedFields: [],
    preservedFields: [],
    imageKind: "none",
    discovery: null,
    ...extras
  };
}

/**
 * Enrich one commercial tap from official brewery beer discovery.
 * Mutates the tap row only for empty style/ABV/image fields.
 */
export async function enrichCommercialTap(
  tapId: number,
  deps: CommercialTapEnrichmentDeps = {}
): Promise<CommercialTapEnrichmentResult> {
  const row = loadTapRow(tapId);
  if (!row) {
    return emptyResult("error", "tap_not_found");
  }

  if (isTapEmpty(row)) {
    return emptyResult("skipped_empty", "tap_empty");
  }

  if (!isCommercialTap(row)) {
    return emptyResult("skipped_homebrew", "homebrew_excluded");
  }

  if (!isOfficialBreweryDiscoveryEnabled()) {
    return emptyResult("disabled", "feature_disabled");
  }

  const breweryName = text(row.maker);
  const beerName = text(row.brewery_batch);
  if (!breweryName || !beerName) {
    return emptyResult("skipped_incomplete_identity", "maker_and_beer_required");
  }

  const resolveWebsite = deps.resolveWebsite ?? resolveCommercialTapBreweryWebsite;
  const website = await resolveWebsite({ breweryName, beerName, tapId });

  if (website.websiteUrl) {
    upsertEnrichmentSource({
      entityType: COMMERCIAL_TAP_ENTITY_TYPE,
      entityId: tapId,
      sourceType: "official_brewery_domain",
      sourceUrl: website.websiteUrl
    });
  }

  const discovery = await discoverOfficialBeerProductPage(
    {
      breweryName,
      beerName,
      breweryWebsiteUrl: website.websiteUrl,
      breweryWebsiteHost: website.websiteHost,
      style: text(row.style) || null
    },
    deps.discoveryDeps
  );

  if (discovery.status !== "matched" || !ACCEPTED_MATCHES.has(discovery.match)) {
    return emptyResult(
      discovery.status === "disabled" ? "disabled" : "no_result",
      discovery.reason || discovery.status,
      {
        match: discovery.match,
        productPageUrl: discovery.productPageUrl,
        discovery
      }
    );
  }

  if (discovery.productPageUrl) {
    upsertEnrichmentSource({
      entityType: COMMERCIAL_TAP_ENTITY_TYPE,
      entityId: tapId,
      sourceType: "official_product_page",
      sourceUrl: discovery.productPageUrl
    });
  }

  const updates: Record<string, unknown> = {};
  const updatedFields: string[] = [];
  const preservedFields: string[] = [];

  // Identity inputs are Keeper/source of truth — never overwrite.
  preservedFields.push("maker", "brewery_batch", "notes");

  if (styleIsEmpty(row.style) && text(discovery.fields.style)) {
    updates.style = text(discovery.fields.style);
    updatedFields.push("style");
  } else if (!styleIsEmpty(row.style)) {
    preservedFields.push("style");
  }

  if (abvIsEmpty(row.abv) && discovery.fields.abv != null && discovery.fields.abv > 0) {
    updates.abv = discovery.fields.abv;
    updatedFields.push("abv");
  } else if (!abvIsEmpty(row.abv)) {
    preservedFields.push("abv");
  }

  let imageKind: CommercialTapImageKind = "none";
  if (!imageIsEmpty(row.image_url)) {
    imageKind = "keeper";
    preservedFields.push("image_url");
  } else {
    const image = await resolveImageForTap({
      discovery,
      breweryName,
      beerName,
      websiteUrl: website.websiteUrl,
      deps
    });
    if (image.url) {
      const localized =
        (await localizeImage(image.url, deps.localizeImageDeps)) ?? image.url;
      updates.image_url = localized;
      updatedFields.push("image_url");
      imageKind = image.kind;
    }
  }

  if (updatedFields.length > 0) {
    const sets = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .concat(["updated_at = CURRENT_TIMESTAMP"]);
    const values = Object.keys(updates).map((key) => updates[key]);
    db.prepare(`UPDATE taps SET ${sets.join(", ")} WHERE id = ?`).run(...values, tapId);
  }

  return {
    status: "matched",
    match: discovery.match,
    reason: "exact_or_strong_official_match",
    productPageUrl: discovery.productPageUrl,
    updatedFields,
    preservedFields: [...new Set(preservedFields)],
    imageKind,
    discovery
  };
}

export function commercialTapEnrichmentResultPayload(
  result: CommercialTapEnrichmentResult
): Record<string, unknown> {
  return {
    status: result.status,
    match: result.match,
    reason: result.reason,
    productPageUrl: result.productPageUrl,
    updatedFields: result.updatedFields,
    preservedFields: result.preservedFields,
    imageKind: result.imageKind
  };
}
