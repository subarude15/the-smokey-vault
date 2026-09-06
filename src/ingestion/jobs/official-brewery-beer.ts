/**
 * Apply official brewery beer product-page discovery during packaged-beer metadata enrichment.
 * Domain-scoped only — never blocks autocomplete / BottleSuggest.
 */
import { parseBeerQuery } from "../../beer_search_query.js";
import {
  discoverOfficialBeerProductPage,
  isOfficialBreweryDiscoveryEnabled,
  type OfficialBeerDiscoveryDeps,
  type OfficialBeerDiscoveryResult
} from "../../official_brewery_beer_discovery.js";
import { resolveBreweryHints } from "../../open_brewery_db.js";
import {
  field,
  mergeField,
  type BottleCandidate,
  type ProductField
} from "../candidate/index.js";
import { getEnrichmentSource, upsertEnrichmentSource } from "./enrichment-sources.js";
import { upsertProductContent } from "./product-content.js";
import {
  applyOfficialBeerRepairs,
  type OfficialRepairSummary
} from "./official-beer-repair.js";

export type OfficialBreweryBeerApplyResult = {
  attempted: boolean;
  discovery: OfficialBeerDiscoveryResult | null;
  candidate: BottleCandidate;
  productPageStored: boolean;
  abvUpdated: boolean;
  notesStored: boolean;
  styleUpdated: boolean;
  imageRepairRequested: boolean;
  repairSummary: OfficialRepairSummary | null;
  /** Brewery website host actually used for this attempt (row/source/OBDB). */
  resolvedWebsiteHost: string | null;
  resolvedWebsiteUrl: string | null;
};

function cloneField<T>(f: ProductField<T>): ProductField<T> {
  return {
    ...f,
    contributors: f.contributors ? f.contributors.map((c) => ({ ...c })) : undefined
  };
}

function cloneCandidate(candidate: BottleCandidate): BottleCandidate {
  return {
    ...candidate,
    upc: cloneField(candidate.upc),
    name: cloneField(candidate.name),
    brand: cloneField(candidate.brand),
    product_type: cloneField(candidate.product_type),
    category: cloneField(candidate.category),
    abv: cloneField(candidate.abv),
    proof: cloneField(candidate.proof),
    volume_ml: cloneField(candidate.volume_ml),
    origin: cloneField(candidate.origin),
    ttb_id: cloneField(candidate.ttb_id)
  };
}

async function resolveBreweryWebsite(args: {
  breweryName: string;
  beerName: string;
  websiteUrl?: string | null;
  websiteHost?: string | null;
  entityType?: string;
  entityId?: number;
}): Promise<{ websiteUrl: string | null; websiteHost: string | null }> {
  if (args.websiteUrl || args.websiteHost) {
    return {
      websiteUrl: args.websiteUrl ?? null,
      websiteHost: args.websiteHost ?? null
    };
  }
  if (args.entityType && args.entityId != null) {
    const stored = getEnrichmentSource(
      args.entityType,
      args.entityId,
      "official_brewery_domain"
    );
    if (stored?.sourceUrl) {
      return {
        websiteUrl: stored.sourceUrl,
        websiteHost: (() => {
          try {
            return new URL(stored.sourceUrl).hostname.replace(/^www\./, "");
          } catch {
            return stored.sourceUrl.replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0] || null;
          }
        })()
      };
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

/**
 * Discover the official brewery product page for a packaged beer and merge
 * high-confidence ABV / notes / product URL without overriding vault/user values.
 */
export async function applyOfficialBreweryBeerDiscovery(options: {
  entityType: string;
  entityId: number;
  candidate: BottleCandidate;
  row: Record<string, unknown>;
  discoveryDeps?: OfficialBeerDiscoveryDeps;
}): Promise<OfficialBreweryBeerApplyResult> {
  let candidate = cloneCandidate(options.candidate);

  if (options.entityType !== "packaged_beer") {
    return {
      attempted: false,
      discovery: null,
      candidate,
      productPageStored: false,
      abvUpdated: false,
      notesStored: false,
      styleUpdated: false,
      imageRepairRequested: false,
      repairSummary: null,
      resolvedWebsiteHost: null,
      resolvedWebsiteUrl: null
    };
  }

  if (!isOfficialBreweryDiscoveryEnabled()) {
    return {
      attempted: false,
      discovery: null,
      candidate,
      productPageStored: false,
      abvUpdated: false,
      notesStored: false,
      styleUpdated: false,
      imageRepairRequested: false,
      repairSummary: null,
      resolvedWebsiteHost: null,
      resolvedWebsiteUrl: null
    };
  }

  const breweryName = String(
    options.row.brewery ?? options.row.brand ?? candidate.brand.value ?? ""
  ).trim();
  const beerName = String(options.row.name ?? candidate.name.value ?? "").trim();
  if (!breweryName || !beerName) {
    return {
      attempted: false,
      discovery: null,
      candidate,
      productPageStored: false,
      abvUpdated: false,
      notesStored: false,
      styleUpdated: false,
      imageRepairRequested: false,
      repairSummary: null,
      resolvedWebsiteHost: null,
      resolvedWebsiteUrl: null
    };
  }

  const website = await resolveBreweryWebsite({
    breweryName,
    beerName,
    websiteUrl: (options.row.website_url as string | null | undefined) ?? null,
    websiteHost: (options.row.website_host as string | null | undefined) ?? null,
    entityType: options.entityType,
    entityId: options.entityId
  });

  const discovery = await discoverOfficialBeerProductPage(
    {
      breweryName,
      beerName,
      breweryWebsiteUrl: website.websiteUrl,
      breweryWebsiteHost: website.websiteHost,
      style: (options.row.style as string | null | undefined) ?? candidate.category.value,
      upc: candidate.upc.value
    },
    options.discoveryDeps
  );

  let productPageStored = false;
  let abvUpdated = false;
  let notesStored = false;
  let styleUpdated = false;
  let imageRepairRequested = false;
  let repairSummary: OfficialRepairSummary | null = null;

  if (discovery.status === "matched" && discovery.productPageUrl) {
    upsertEnrichmentSource({
      entityType: options.entityType,
      entityId: options.entityId,
      sourceType: "official_product_page",
      sourceUrl: discovery.productPageUrl
    });
    productPageStored = true;

    if (discovery.fields.abv != null) {
      const beforeSource = candidate.abv.source;
      const beforeValue = candidate.abv.value;
      const merged = mergeField(
        candidate.abv,
        field(discovery.fields.abv, "official_brewery"),
        "abv"
      );
      candidate.abv = merged.field;
      if (merged.overwritten || (beforeValue == null && candidate.abv.value != null)) {
        abvUpdated =
          beforeSource !== "vault" &&
          beforeSource !== "user" &&
          beforeSource !== "barcode_cache";
        if (beforeValue == null) abvUpdated = true;
        if (
          beforeSource === "vault" ||
          beforeSource === "user" ||
          beforeSource === "barcode_cache"
        ) {
          abvUpdated = false;
        } else if (merged.overwritten || beforeValue == null) {
          abvUpdated = true;
        }
      }
    }

    const notes =
      discovery.fields.tastingNotes?.trim() ||
      discovery.fields.description?.trim() ||
      null;
    if (notes) {
      upsertProductContent({
        entityType: "packaged_beer",
        entityId: options.entityId,
        officialNotes: notes,
        officialSourceUrl: discovery.productPageUrl,
        officialSourceType: "official"
      });
      notesStored = true;
    }

    // Narrow exact/strong-match repair for machine-owned style/ABV/image.
    // Does not change global authority ranking; Keeper/user values stay protected.
    const repaired = applyOfficialBeerRepairs({
      entityType: "packaged_beer",
      entityId: options.entityId,
      row: options.row,
      candidate,
      discovery
    });
    candidate = repaired.candidate;
    repairSummary = repaired.summary;
    if (repaired.summary.styleRepaired) styleUpdated = true;
    if (repaired.summary.abvRepaired) abvUpdated = true;
    if (repaired.summary.imageRepairRequested) imageRepairRequested = true;
  }

  return {
    attempted: true,
    discovery,
    candidate,
    productPageStored,
    abvUpdated,
    notesStored,
    styleUpdated,
    imageRepairRequested,
    repairSummary,
    resolvedWebsiteHost: website.websiteHost,
    resolvedWebsiteUrl: website.websiteUrl
  };
}
