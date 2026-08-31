import type { ProductSchema } from "../../cola_client.js";
import type { LookupResult } from "../../lookup-shared.js";
import {
  isCommerceTaxonomyJunk,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl,
  stripPackageTokensFromName
} from "../../canonical-normalize.js";
import { confidenceForSource, fieldSourceFromLookupSource } from "./confidence.js";
import { emptyField, field, isUnresolvedField, mergeField } from "./fields.js";
import type {
  BottleCandidate,
  BottleCandidateFieldName,
  FieldConflict,
  ProductField,
  ProductFieldSource
} from "./types.js";

function stringFrom(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const raw = record[key];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (text) return text;
  }
  return null;
}

function numberFrom(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const raw = record[key];
    if (raw == null || raw === "") continue;
    const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function classificationFromRecord(record: Record<string, unknown>): {
  productType: string | null;
  category: string | null;
} {
  const categoryRaw = stringFrom(record, "category", "categories", "style") ?? "";
  const subRaw = stringFrom(record, "sub_category", "subcategory") ?? "";
  const tax = normalizeCanonicalTaxonomy(categoryRaw, subRaw);
  const productTypeRaw = stringFrom(record, "product_type");
  const productType =
    tax.productType
    ?? (productTypeRaw
      ? (/distilled\s+spirit/i.test(productTypeRaw)
        ? "spirit"
        : /malt\s+beverage/i.test(productTypeRaw)
          ? "beer"
          : /\bwine\b/i.test(productTypeRaw)
            ? "wine"
            : productTypeRaw.toLowerCase())
      : null);

  // Most specific alcohol label for provenance/display (Scotch Whisky > Whiskey).
  let category = tax.type || tax.family || null;
  if (!category && categoryRaw && !isCommerceTaxonomyJunk(categoryRaw) && !categoryRaw.includes(">")) {
    category = categoryRaw;
  }
  return { productType, category };
}

/** Build a candidate from a ProductSchema / inventory-like record with one provenance source. */
export function candidateFromProduct(
  product: ProductSchema | Record<string, unknown>,
  source: ProductFieldSource
): BottleCandidate {
  const record = product as Record<string, unknown>;
  const { productType, category } = classificationFromRecord(record);
  const nameRaw = stringFrom(record, "name", "product_name", "batch_name");
  const name = nameRaw ? stripPackageTokensFromName(nameRaw) || nameRaw : null;
  const abv = normalizeCanonicalAbv(numberFrom(record, "abv"), { productType });
  const proof = normalizeCanonicalProof(numberFrom(record, "proof"));
  const volume = normalizeCanonicalVolumeMl(numberFrom(record, "volume_ml"));

  return {
    primarySource: source,
    upc: field(stringFrom(record, "upc"), source),
    name: field(name, source),
    brand: field(stringFrom(record, "brand", "brewery", "producer", "maker", "brand_name"), source),
    product_type: field(productType, source),
    category: field(category, source),
    abv: field(abv, source),
    proof: field(proof, source),
    volume_ml: field(volume, source),
    origin: field(stringFrom(record, "origin", "origin_name"), source),
    ttb_id: field(stringFrom(record, "ttb_id"), source)
  };
}

/**
 * Convert a LookupResult into an internal candidate.
 * Misses yield unresolved fields (upc may still be set). Does not throw.
 */
export function candidateFromLookup(result: LookupResult): BottleCandidate {
  const source = fieldSourceFromLookupSource(result.source);
  if (!result.product || result.source === "not_found") {
    return {
      primarySource: source,
      upc: field(result.upc || null, source),
      name: emptyField(),
      brand: emptyField(),
      product_type: emptyField(),
      category: emptyField(),
      abv: emptyField(),
      proof: emptyField(),
      volume_ml: emptyField(),
      origin: emptyField(),
      ttb_id: emptyField()
    };
  }
  const candidate = candidateFromProduct(result.product, source);
  if (!candidate.upc.value && result.upc) {
    candidate.upc = field(result.upc, source);
  }
  return candidate;
}

export function unresolvedFields(candidate: BottleCandidate): BottleCandidateFieldName[] {
  const names: BottleCandidateFieldName[] = [
    "upc", "name", "brand", "product_type", "category",
    "abv", "proof", "volume_ml", "origin", "ttb_id"
  ];
  return names.filter((name) => isUnresolvedField(candidate[name] as ProductField<unknown>));
}

export type CandidateMergeResult = {
  candidate: BottleCandidate;
  conflicts: FieldConflict[];
  overwritten: BottleCandidateFieldName[];
};

function setField(
  candidate: BottleCandidate,
  name: BottleCandidateFieldName,
  next: ProductField<unknown>
) {
  (candidate as unknown as Record<string, ProductField<unknown>>)[name] = next;
}

/** Merge field-by-field; weaker sources never overwrite stronger ones. */
export function mergeCandidates(
  existing: BottleCandidate,
  incoming: BottleCandidate
): CandidateMergeResult {
  const conflicts: FieldConflict[] = [];
  const overwritten: BottleCandidateFieldName[] = [];
  const names: BottleCandidateFieldName[] = [
    "upc", "name", "brand", "product_type", "category",
    "abv", "proof", "volume_ml", "origin", "ttb_id"
  ];

  const next: BottleCandidate = {
    ...existing,
    primarySource:
      confidenceForSource(incoming.primarySource) > confidenceForSource(existing.primarySource)
        ? incoming.primarySource
        : existing.primarySource
  };

  for (const name of names) {
    const merged = mergeField(
      existing[name] as ProductField<unknown>,
      incoming[name] as ProductField<unknown>,
      name
    );
    setField(next, name, merged.field);
    if (merged.overwritten) overwritten.push(name);
    if (merged.conflict) conflicts.push(merged.conflict as FieldConflict);
  }

  return { candidate: next, conflicts, overwritten };
}
