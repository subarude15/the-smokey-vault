/**
 * Deterministic normalization for external commerce taxonomy and numeric sentinels.
 * No LLM confidence — only text evidence and hard numeric bounds.
 */

/** Compact product_type vocabulary used across candidates / enrichment. */
export const CANONICAL_PRODUCT_TYPES = ["spirit", "wine", "beer", "mixer"] as const;
export type CanonicalProductType = (typeof CANONICAL_PRODUCT_TYPES)[number];

/** Matches client SPIRIT_FAMILIES / vault select options. */
export const CANONICAL_SPIRIT_FAMILIES = [
  "Whiskey",
  "Gin",
  "Rum",
  "Tequila",
  "Mezcal",
  "Vodka",
  "Cognac",
  "Brandy",
  "Amaro",
  "Liqueur",
  "Bitters",
  "Mixer"
] as const;

export type CanonicalSpiritFamily = (typeof CANONICAL_SPIRIT_FAMILIES)[number];

export const CANONICAL_WHISKEY_TYPES = [
  "Bourbon",
  "Rye",
  "Scotch",
  "Irish",
  "Corn whiskey",
  "Tennessee",
  "Canadian",
  "Japanese",
  "Blended",
  "Wheat whiskey"
] as const;

/** Ecommerce / grocery taxonomy leaves that must never become canonical family/type. */
const COMMERCE_JUNK_LEAVES = new Set([
  "food",
  "grocery",
  "groceries",
  "beverages",
  "beverage",
  "drinks",
  "drink",
  "alcoholic beverages",
  "alcoholic beverage",
  "alcohol",
  "liquor & spirits",
  "liquor and spirits",
  "liquor",
  "spirits",
  "food beverages & tobacco",
  "food, beverages & tobacco",
  "food beverages and tobacco",
  "tobacco",
  "household",
  "general merchandise",
  "uncategorized",
  "other",
  "n/a",
  "na",
  "none",
  "unknown"
]);

const FAMILY_ALIASES: Array<{ pattern: RegExp; family: CanonicalSpiritFamily }> = [
  { pattern: /\b(whisky|whiskey)\b/i, family: "Whiskey" },
  { pattern: /\bgin\b/i, family: "Gin" },
  { pattern: /\btequila\b/i, family: "Tequila" },
  { pattern: /\bmezcal\b/i, family: "Mezcal" },
  { pattern: /\brum\b/i, family: "Rum" },
  { pattern: /\bamaro\b/i, family: "Amaro" },
  { pattern: /\b(liqueur|cordial)\b/i, family: "Liqueur" },
  { pattern: /\bbitters?\b/i, family: "Bitters" },
  { pattern: /\bvodka\b/i, family: "Vodka" },
  { pattern: /\bcognac\b/i, family: "Cognac" },
  { pattern: /\b(brandy|armagnac|pisco)\b/i, family: "Brandy" },
  { pattern: /\bmixer\b/i, family: "Mixer" }
];

const PRODUCT_TYPE_HINTS: Array<{ pattern: RegExp; type: CanonicalProductType }> = [
  { pattern: /\b(wine|sparkling|champagne|prosecco|vermouth|sake)\b/i, type: "wine" },
  { pattern: /\b(beer|ale|ipa|lager|stout|porter|pilsner|cider|seltzer|malt\s+beverage)\b/i, type: "beer" },
  {
    pattern: /\b(spirit|whisky|whiskey|bourbon|scotch|rye|gin|vodka|rum|tequila|mezcal|brandy|cognac|liqueur|liquor)\b/i,
    type: "spirit"
  },
  { pattern: /\b(mixer|tonic|soda|syrup)\b/i, type: "mixer" }
];

export type CanonicalTaxonomy = {
  productType: CanonicalProductType | null;
  family: string;
  type: string;
  /** True when input looked like hierarchical or grocery commerce taxonomy. */
  wasCommerceTaxonomy: boolean;
  /** True when a raw junk leaf was discarded. */
  discardedJunk: boolean;
};

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Split hierarchical commerce paths and comma lists into segments. */
export function taxonomySegments(raw: string): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const parts = text
    .split(/>|,/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

export function isCommerceTaxonomyJunk(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (text.includes(">")) {
    const segments = taxonomySegments(text);
    // Hierarchical commerce paths are junk as whole values unless a spirit leaf remains.
    return segments.every((segment) => COMMERCE_JUNK_LEAVES.has(normalizeKey(segment)))
      || (segments.length > 1 && !canonicalFamilyFromText(text) && !canonicalWhiskeyTypeFromText(text));
  }
  return COMMERCE_JUNK_LEAVES.has(normalizeKey(text));
}

/** True when a stored family/type is usable as canonical shelf vocabulary. */
export function isUsableCanonicalFamily(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (isCommerceTaxonomyJunk(text)) return false;
  if (text.includes(">")) return false;
  const known = CANONICAL_SPIRIT_FAMILIES.find((family) => family.toLowerCase() === text.toLowerCase());
  if (known) return true;
  // Known whiskey types may appear as family in older rows before lifting.
  if (canonicalWhiskeyTypeFromText(text)) return true;
  // Allow other short non-taxonomy labels (e.g. wine families elsewhere) — reject long paths.
  if (text.length > 40) return false;
  if (/food|beverage|tobacco|grocery/i.test(text) && !/\b(whisky|whiskey|gin|rum|vodka|tequila)\b/i.test(text)) {
    return false;
  }
  return true;
}

export function isUsableCanonicalType(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (isCommerceTaxonomyJunk(text)) return false;
  if (text.includes(">")) return false;
  if (text.length > 40) return false;
  if (/food|beverage|tobacco|grocery|liquor\s*&\s*spirits/i.test(text)) return false;
  return true;
}

function matchCanonicalFamilyLabel(text: string): CanonicalSpiritFamily | null {
  const key = normalizeKey(text);
  for (const family of CANONICAL_SPIRIT_FAMILIES) {
    if (normalizeKey(family) === key) return family;
  }
  if (key === "whisky") return "Whiskey";
  return null;
}

export function canonicalFamilyFromText(haystack: string): CanonicalSpiritFamily | null {
  const exact = matchCanonicalFamilyLabel(haystack.trim());
  if (exact) return exact;
  for (const { pattern, family } of FAMILY_ALIASES) {
    if (pattern.test(haystack)) return family;
  }
  return null;
}

export function canonicalWhiskeyTypeFromText(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  const found = CANONICAL_WHISKEY_TYPES.find((value) => lower.includes(value.toLowerCase()));
  return found ?? null;
}

function inferProductType(haystack: string, family: string): CanonicalProductType | null {
  for (const { pattern, type } of PRODUCT_TYPE_HINTS) {
    if (pattern.test(haystack)) return type;
  }
  if (family && family !== "Mixer") return "spirit";
  if (family === "Mixer") return "mixer";
  return null;
}

/**
 * Map raw category / subcategory (including UPCitemdb-style paths) to vault vocabulary.
 * Never invents subtype without supporting text. Never preserves Food / Beverages junk.
 */
export function normalizeCanonicalTaxonomy(
  category: string | null | undefined,
  subCategory: string | null | undefined = ""
): CanonicalTaxonomy {
  const familyRaw = String(category ?? "").trim();
  const typeRaw = String(subCategory ?? "").trim();
  const combined = `${familyRaw} ${typeRaw}`.trim();
  const wasCommerceTaxonomy =
    familyRaw.includes(">")
    || typeRaw.includes(">")
    || isCommerceTaxonomyJunk(familyRaw)
    || isCommerceTaxonomyJunk(typeRaw)
    || /food,\s*beverages/i.test(combined);

  if (!combined) {
    return { productType: null, family: "", type: "", wasCommerceTaxonomy: false, discardedJunk: false };
  }

  const segments = [...taxonomySegments(familyRaw), ...taxonomySegments(typeRaw)];
  const haystack = segments.join(" ");

  let family = canonicalFamilyFromText(haystack) ?? "";
  let type = "";

  // Prefer an explicit usable subtype from subCategory when present.
  if (typeRaw && isUsableCanonicalType(typeRaw)) {
    type = typeRaw;
  }

  const whiskeyType = canonicalWhiskeyTypeFromText(haystack);
  if (family === "Whiskey" || whiskeyType || /\b(whisky|whiskey)\b/i.test(haystack)) {
    family = "Whiskey";
    if (!type) {
      // Only assign subtype when text supports a known whiskey type — not bare "Whiskey".
      type = whiskeyType && whiskeyType.toLowerCase() !== "whiskey" ? whiskeyType : "";
    } else if (!isUsableCanonicalType(type)) {
      type = whiskeyType && whiskeyType.toLowerCase() !== "whiskey" ? whiskeyType : "";
    }
  } else if (!family) {
    // Lift bare whiskey types (Bourbon, Rye, …) into Whiskey family.
    if (whiskeyType) {
      family = "Whiskey";
      type = whiskeyType;
    }
  }

  // If familyRaw was already a known family and typeRaw empty, keep family; do not invent type.
  if (!family) {
    const exact = matchCanonicalFamilyLabel(familyRaw);
    if (exact) family = exact;
  }

  // Discard junk that survived as family/type.
  let discardedJunk = false;
  if (family && !isUsableCanonicalFamily(family)) {
    discardedJunk = true;
    family = "";
  }
  if (type && !isUsableCanonicalType(type)) {
    discardedJunk = true;
    type = "";
  }
  if (wasCommerceTaxonomy && (!family || isCommerceTaxonomyJunk(familyRaw))) {
    discardedJunk = true;
  }

  // Empty family with no spirit evidence: do not fall back to raw "Food".
  if (!family && (isCommerceTaxonomyJunk(familyRaw) || isCommerceTaxonomyJunk(typeRaw))) {
    discardedJunk = true;
  }

  const productType = inferProductType(haystack || combined, family);

  return {
    productType,
    family,
    type,
    wasCommerceTaxonomy,
    discardedJunk
  };
}

/** ABV: reject 0 / negative / NaN / >100 unless explicitly non-alcoholic. */
export function normalizeCanonicalAbv(
  raw: unknown,
  options: { allowZero?: boolean; productType?: string | null } = {}
): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw).match(/-?\d+(?:\.\d+)?/)?.[0] ?? "");
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  const nonAlcoholic =
    options.allowZero
    || /non[- ]?alcoholic|na\b|0\.0\s*%\s*abv/i.test(String(raw))
    || String(options.productType ?? "").toLowerCase() === "mixer";
  if (n === 0 && !nonAlcoholic) return null;
  return Math.round(n * 10) / 10;
}

/** Proof: reject 0 / negative / impossible (>200). */
export function normalizeCanonicalProof(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw).match(/-?\d+(?:\.\d+)?/)?.[0] ?? "");
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 200) return null;
  return Math.round(n * 10) / 10;
}

/** Volume ml: reject 0 / negative / absurd (>20 L). */
export function normalizeCanonicalVolumeMl(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw).match(/-?\d+(?:\.\d+)?/)?.[0] ?? "");
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 20_000) return null;
  return Math.round(n);
}

/**
 * Strip obvious package-size tokens from product names.
 * Does not rewrite brand/product identity or fix spelling.
 */
export function stripPackageTokensFromName(name: string): string {
  let next = String(name ?? "").trim();
  if (!next) return "";
  next = next
    .replace(/\b\d+(?:\.\d+)?\s*(?:ml|mL|ML)\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:l|L)\b(?![a-zA-Z])/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*)?oz\.?\b/gi, " ")
    .replace(/\b\d+\s*[xX]\s*\d+\b/g, " ")
    .replace(/\b(?:pack|pk|ct|count)\s*of\s*\d+\b/gi, " ")
    .replace(/\b\d+\s*(?:pack|pk|ct|count)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[-–—,|/]+\s*$/g, "")
    .replace(/^\s*[-–—,|/]+\s*/g, "")
    .trim();
  return next || String(name ?? "").trim();
}

/**
 * Apply taxonomy + numeric + name cleanup to an inventory-like product record
 * before persistence or enrichment planning. Does not invent identity.
 */
export function normalizeProductRecordForPersistence(
  product: Record<string, unknown>
): Record<string, unknown> {
  const category = String(product.category ?? product.categories ?? product.style ?? "");
  const subCategory = String(product.sub_category ?? product.subcategory ?? product.type ?? "");
  const tax = normalizeCanonicalTaxonomy(category, subCategory);
  const productTypeRaw = String(product.product_type ?? "").trim();
  const productType =
    tax.productType
    ?? (CANONICAL_PRODUCT_TYPES.includes(productTypeRaw.toLowerCase() as CanonicalProductType)
      ? (productTypeRaw.toLowerCase() as CanonicalProductType)
      : productTypeRaw || null);

  const nameRaw = String(product.name ?? product.product_name ?? "").trim();
  const name = stripPackageTokensFromName(nameRaw);

  return {
    ...product,
    name: name || nameRaw,
    category: tax.family,
    sub_category: tax.type,
    product_type: productType,
    abv: normalizeCanonicalAbv(product.abv, { productType: typeof productType === "string" ? productType : null }),
    proof: product.proof === undefined ? product.proof : normalizeCanonicalProof(product.proof),
    volume_ml:
      product.volume_ml === undefined
        ? product.volume_ml
        : normalizeCanonicalVolumeMl(product.volume_ml)
  };
}

/** Display-safe family for patron / shelf UI — never returns commerce junk. */
export function displayCanonicalFamily(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text || !isUsableCanonicalFamily(text)) return "";
  const tax = normalizeCanonicalTaxonomy(text, "");
  return tax.family || (isUsableCanonicalFamily(text) ? text : "");
}

/** Display-safe type/subtype — never returns commerce paths. */
export function displayCanonicalType(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text || !isUsableCanonicalType(text)) return "";
  return text;
}
