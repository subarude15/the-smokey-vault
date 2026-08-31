/**
 * Retrieval-only search tokens and progressive query ladders.
 *
 * Search aliases (Yr→Year, spelling variants) must NEVER mutate canonical
 * BottleCandidate fields — they exist only to improve recall.
 */
import { stripPackageTokensFromName } from "../../canonical-normalize.js";
import type { BottleCandidate } from "../candidate/types.js";
import type { MetadataEnrichmentField } from "./metadata-fields.js";

export type SearchIdentityInput = {
  brand?: string | null;
  name?: string | null;
  upc?: string | null;
  product_type?: string | null;
  category?: string | null;
  volume_ml?: string | number | null;
};

export type SearchQueryTier = {
  tier: number;
  label: string;
  query: string;
};

/** Noise tokens never useful for retrieval queries. */
const RETRIEVAL_NOISE = new Set([
  "spirit",
  "spirits",
  "bottle",
  "bottles",
  "pack",
  "packaged",
  "generic",
  "product",
  "photo",
  "image",
  "ml",
  "750",
  "750ml",
  "1l",
  "1.75l"
]);

/**
 * Conservative search-only spelling / abbreviation aliases.
 * Keys are lowercase source tokens; values are alternate retrieval forms.
 */
const SEARCH_TOKEN_ALIASES: Record<string, string[]> = {
  yr: ["year"],
  yrs: ["years"],
  whisky: ["whiskey"],
  whiskey: ["whisky"],
  carribbean: ["caribbean"],
  carribean: ["caribbean"],
  scotch: ["scotch"]
};

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Strip leading "The " for compact brand cores (retrieval only). */
export function brandCoreToken(brand: string): string {
  return cleanWhitespace(String(brand ?? "").replace(/^the\s+/i, ""));
}

/**
 * Apply deterministic search-only aliases to a token.
 * Returns the original plus aliases (deduped). Does not mutate storage.
 */
export function searchAliasesForToken(token: string): string[] {
  const raw = String(token ?? "").trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const out = [raw];
  const aliases = SEARCH_TOKEN_ALIASES[lower];
  if (aliases) {
    for (const alias of aliases) {
      // Preserve source casing style when expanding abbreviations.
      if (lower === "yr") out.push("Year");
      else if (lower === "yrs") out.push("Years");
      else if (alias !== lower) {
        out.push(alias.charAt(0).toUpperCase() + alias.slice(1));
      }
    }
  }
  // Obvious repeated-letter typo: carribbean → caribbean (already mapped).
  // Mild heuristic: collapse triple+ identical letters for search variants.
  const collapsed = raw.replace(/(.)\1{2,}/g, "$1$1");
  if (collapsed !== raw && collapsed.length >= 4) out.push(collapsed);
  return [...new Set(out)];
}

/**
 * Split a product name into safe retrieval tokens.
 * Removes package sizes, duplicated brand text, and generic noise.
 */
export function extractSearchTokens(input: SearchIdentityInput): {
  brand: string;
  brandCore: string;
  upc: string;
  productType: string;
  category: string;
  /** Primary product tokens (preferred spelling variants applied where aliased). */
  productTokens: string[];
  /** All tokens including search-only aliases (for relaxed queries). */
  productTokensWithAliases: string[];
} {
  const brand = cleanWhitespace(String(input.brand ?? ""));
  const brandCore = brandCoreToken(brand);
  const upc = cleanWhitespace(String(input.upc ?? "")).replace(/\D/g, "") || cleanWhitespace(String(input.upc ?? ""));
  const productType = cleanWhitespace(String(input.product_type ?? ""));
  const category = cleanWhitespace(String(input.category ?? ""));

  let name = stripPackageTokensFromName(String(input.name ?? ""));
  // Drop duplicated brand prefixes from the name for retrieval.
  if (brandCore) {
    const brandRe = new RegExp(`^${escapeRegExp(brandCore)}\\s+`, "i");
    const theBrandRe = new RegExp(`^the\\s+${escapeRegExp(brandCore)}\\s+`, "i");
    name = name.replace(theBrandRe, "").replace(brandRe, "");
    // Also strip brand when it appears mid-name as exact duplicate token run.
    name = name
      .split(/\s+/)
      .filter((tok) => normalizeCompare(tok) !== normalizeCompare(brandCore))
      .join(" ");
  }

  const rawTokens = name
    .split(/[\s,/|]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !RETRIEVAL_NOISE.has(t.toLowerCase()))
    .filter((t) => !/^\d+(?:\.\d+)?(?:ml|l|oz)?$/i.test(t));

  const productTokens: string[] = [];
  const productTokensWithAliases: string[] = [];
  for (const tok of rawTokens) {
    const aliases = searchAliasesForToken(tok);
    // Prefer aliased expansion for primary tokens when Yr → Year etc.
    const preferred =
      tok.toLowerCase() === "yr"
        ? "Year"
        : tok.toLowerCase() === "yrs"
          ? "Years"
          : tok.toLowerCase() === "carribbean" || tok.toLowerCase() === "carribean"
            ? "Caribbean"
            : tok;
    if (!productTokens.some((p) => normalizeCompare(p) === normalizeCompare(preferred))) {
      productTokens.push(preferred);
    }
    for (const a of aliases) {
      if (!productTokensWithAliases.some((p) => normalizeCompare(p) === normalizeCompare(a))) {
        productTokensWithAliases.push(a);
      }
    }
  }

  return {
    brand,
    brandCore,
    upc,
    productType: RETRIEVAL_NOISE.has(productType.toLowerCase()) ? "" : productType,
    category,
    productTokens,
    productTokensWithAliases: productTokensWithAliases.length
      ? productTokensWithAliases
      : productTokens
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Quote only short multi-word brand phrases — never the entire stored bottle name. */
export function quoteBrandIfUseful(brand: string): string {
  const trimmed = cleanWhitespace(brand);
  if (!trimmed) return "";
  // Prefer compact brand core unquoted for recall; quote only when brand is multi-word and short.
  const core = brandCoreToken(trimmed);
  if (!core) return "";
  if (/\s/.test(core) && core.split(/\s+/).length <= 3) {
    return `"${core.replace(/"/g, "")}"`;
  }
  return core;
}

export function identityFromCandidate(candidate: BottleCandidate): SearchIdentityInput {
  return {
    brand: candidate.brand.value,
    name: candidate.name.value,
    upc: candidate.upc.value,
    product_type: candidate.product_type.value,
    category: candidate.category.value,
    volume_ml: candidate.volume_ml.value
  };
}

/**
 * Progressive metadata search ladder (bounded).
 * Start specific; relax when earlier tiers return nothing useful.
 */
export function buildMetadataQueryTiers(
  input: SearchIdentityInput,
  needed: MetadataEnrichmentField[] = []
): SearchQueryTier[] {
  const tokens = extractSearchTokens(input);
  const brandQuoted = quoteBrandIfUseful(tokens.brand || tokens.brandCore);
  const brandLoose = tokens.brandCore || tokens.brand;
  const product = tokens.productTokens.join(" ");
  const productLoose = tokens.productTokensWithAliases.join(" ");
  const tiers: SearchQueryTier[] = [];

  const push = (tier: number, label: string, parts: Array<string | null | undefined>) => {
    const query = cleanWhitespace(parts.filter(Boolean).join(" "));
    if (!query) return;
    if (tiers.some((t) => t.query === query)) return;
    tiers.push({ tier, label, query });
  };

  // Tier 1 — UPC-specific (independent of exact stored name)
  if (tokens.upc) {
    push(1, "upc", [tokens.upc, brandLoose]);
    if (brandQuoted && brandQuoted !== brandLoose) {
      push(1, "upc_brand", [brandQuoted, tokens.upc]);
    }
  }

  // Tier 2 — normalized product identity (aliases applied; no full-name quoting)
  push(2, "identity", [brandQuoted || brandLoose, productLoose || product]);

  // Tier 3 — brand + core product tokens + broad type
  const typeHint =
    tokens.category
    || (needed.includes("category") || needed.includes("origin") ? "whisky whiskey" : "");
  push(3, "brand_product", [brandLoose, productLoose || product, typeHint].filter(Boolean));

  // Tier 4 — factual strength query
  if (needed.includes("abv") || needed.includes("proof") || !needed.length) {
    push(4, "factual", [brandLoose, productLoose || product, "ABV"]);
  }

  // Tier 5 — regulatory / COLA
  if (needed.includes("ttb_id") || needed.includes("category") || !needed.length) {
    push(5, "regulatory", [brandLoose, productLoose || product, "COLA"]);
  }

  return tiers.slice(0, 6);
}

/** Flat query list for compatibility with older callers. */
export function buildMetadataSearchQueriesFromIdentity(
  input: SearchIdentityInput,
  needed: MetadataEnrichmentField[] = []
): string[] {
  return buildMetadataQueryTiers(input, needed).map((t) => t.query);
}

/**
 * Progressive image / page-discovery queries (bounded).
 * Avoids stuffing UPC + exact name + product_type into every request.
 */
export function buildImageQueryTiers(input: SearchIdentityInput): SearchQueryTier[] {
  const tokens = extractSearchTokens(input);
  const brandLoose = tokens.brandCore || tokens.brand;
  const product = tokens.productTokensWithAliases.join(" ") || tokens.productTokens.join(" ");
  const tiers: SearchQueryTier[] = [];

  const push = (tier: number, label: string, parts: Array<string | null | undefined>) => {
    const query = cleanWhitespace(parts.filter(Boolean).join(" "));
    if (!query) return;
    if (tiers.some((t) => t.query === query)) return;
    tiers.push({ tier, label, query });
  };

  push(1, "product_photo", [brandLoose, product, "bottle"]);
  if (tokens.upc) {
    push(2, "upc_photo", [tokens.upc, brandLoose, "bottle"]);
  }
  push(3, "official_site", [brandLoose, product, "official"]);
  push(4, "brand_site", [brandLoose, "official site"]);

  return tiers.slice(0, 4);
}

/** True when a query appears to exact-quote the entire raw stored name. */
export function queryQuotesEntireName(query: string, rawName: string): boolean {
  const name = cleanWhitespace(rawName);
  if (!name || !/\s/.test(name)) return false;
  const quoted = `"${name.replace(/"/g, "")}"`;
  return query.includes(quoted);
}
