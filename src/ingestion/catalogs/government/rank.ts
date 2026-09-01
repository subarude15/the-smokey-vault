/**
 * Deterministic ranking for government catalog barcode candidates.
 * Never auto-prefer PA over Iowa. Conflicts remain conflicts.
 */
import type {
  CatalogProductRecord,
  GovernmentCandidate,
  GovernmentDataset,
  GovernmentLookupResult
} from "./types.js";
import { isGiftOrSpecialtyPackage } from "./taxonomy.js";

export type RankableHit = {
  product: CatalogProductRecord;
  dataset: GovernmentDataset;
  matchedCodeRaw: string | null;
  matchedCodeNormalized: string | null;
  exactRawMatch: boolean;
  isCurrent: boolean;
  extractedAt: string | null;
};

function fieldCompleteness(product: CatalogProductRecord): number {
  const fields = [
    product.name,
    product.brand,
    product.volumeMl,
    product.proof,
    product.abvPercent,
    product.country,
    product.regionRaw,
    product.normalizedFamily,
    product.normalizedSubcategory,
    product.sourceGroup,
    product.sourceClass
  ];
  let score = 0;
  for (const value of fields) {
    if (value != null && value !== "") score += 1;
  }
  return score;
}

function packageScore(product: CatalogProductRecord): number {
  let score = 0;
  if (product.volumeMl != null) score += 3;
  if (!isGiftOrSpecialtyPackage(product.name)) score += 4;
  const flags = product.qualityFlagsJson ?? "";
  if (/gift_or_specialty_package/.test(flags)) score -= 4;
  return score;
}

function agreementBoost(hits: RankableHit[], hit: RankableHit): number {
  // Independent sources agreeing on core identity strengthens a candidate.
  const peers = hits.filter((h) => h.product.id !== hit.product.id);
  let boost = 0;
  for (const peer of peers) {
    if (peer.dataset === hit.dataset) continue;
    let agrees = 0;
    if (
      hit.product.volumeMl != null &&
      peer.product.volumeMl != null &&
      hit.product.volumeMl === peer.product.volumeMl
    ) {
      agrees++;
    }
    if (
      hit.product.proof != null &&
      peer.product.proof != null &&
      Math.abs(hit.product.proof - peer.product.proof) < 0.05
    ) {
      agrees++;
    }
    const a = hit.product.name.toLowerCase();
    const b = peer.product.name.toLowerCase();
    if (a && b && (a.includes(b) || b.includes(a))) agrees++;
    if (
      hit.product.normalizedFamily &&
      peer.product.normalizedFamily &&
      hit.product.normalizedFamily === peer.product.normalizedFamily
    ) {
      agrees++;
    }
    if (agrees >= 3) boost += 8;
    else if (agrees === 2) boost += 4;
  }
  return boost;
}

function materialConflict(a: RankableHit, b: RankableHit): boolean {
  if (a.dataset === b.dataset) {
    // Same dataset, different products for one barcode → ambiguity.
    return a.product.id !== b.product.id;
  }
  // Cross-source: conflict when package or proof clearly disagree.
  if (
    a.product.volumeMl != null &&
    b.product.volumeMl != null &&
    a.product.volumeMl !== b.product.volumeMl
  ) {
    return true;
  }
  if (
    a.product.proof != null &&
    b.product.proof != null &&
    Math.abs(a.product.proof - b.product.proof) >= 1
  ) {
    return true;
  }
  const an = a.product.name.toLowerCase();
  const bn = b.product.name.toLowerCase();
  if (an && bn && !an.includes(bn) && !bn.includes(an)) {
    // Names share no containment — treat as material if volumes/proofs also absent agreement.
    if (a.product.volumeMl == null || b.product.volumeMl == null) return true;
  }
  return false;
}

export function scoreGovernmentHit(hit: RankableHit, all: RankableHit[]): number {
  let score = 0;
  if (hit.exactRawMatch) score += 40;
  if (hit.matchedCodeNormalized) score += 10;
  if (hit.isCurrent) score += 12;
  if (hit.extractedAt) score += 2;
  score += packageScore(hit.product);
  score += fieldCompleteness(hit.product);
  score += agreementBoost(all, hit);
  // No dataset bias: PA and Iowa start equal.
  return score;
}

export function rankGovernmentHits(hits: RankableHit[]): GovernmentLookupResult {
  if (!hits.length) {
    return { status: "miss", candidates: [], winner: null };
  }

  const scored: GovernmentCandidate[] = hits
    .map((hit) => ({
      product: hit.product,
      dataset: hit.dataset,
      matchedCodeRaw: hit.matchedCodeRaw,
      matchedCodeNormalized: hit.matchedCodeNormalized,
      exactRawMatch: hit.exactRawMatch,
      score: scoreGovernmentHit(hit, hits),
      qualityFlags: hit.product.qualityFlagsJson
        ? (JSON.parse(hit.product.qualityFlagsJson) as string[])
        : []
    }))
    .sort((a, b) => b.score - a.score || a.product.id - b.product.id);

  if (scored.length === 1) {
    return { status: "hit", candidates: scored, winner: scored[0]! };
  }

  const top = scored[0]!;
  const second = scored[1]!;
  const topHit = hits.find((h) => h.product.id === top.product.id)!;
  const secondHit = hits.find((h) => h.product.id === second.product.id)!;

  // Clear winner when score gap is decisive and no material conflict.
  if (top.score >= second.score + 10 && !materialConflict(topHit, secondHit)) {
    return { status: "hit", candidates: scored, winner: top };
  }

  // Agreement across independent datasets with compatible identity → hit.
  if (
    topHit.dataset !== secondHit.dataset &&
    !materialConflict(topHit, secondHit) &&
    agreementBoost(hits, topHit) >= 4
  ) {
    return { status: "hit", candidates: scored, winner: top };
  }

  return {
    status: "ambiguous",
    candidates: scored,
    winner: null,
    message: "Multiple government catalog candidates require review"
  };
}
