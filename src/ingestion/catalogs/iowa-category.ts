/**
 * Deterministic Iowa category specificity ranking.
 *
 * Same item_no can appear under Temporary & Specialty Packages and a useful
 * spirit category (e.g. Imported Vodkas). Prefer the useful spirit row.
 */

/** Lower score = more generic / less useful as a canonical family signal. */
const GENERIC_CATEGORY_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^temporary\s*&\s*specialty\s+packages$/i, score: 0 },
  { pattern: /^special\s+order\s+items$/i, score: 1 },
  { pattern: /^cocktails\s*\/\s*rtd$/i, score: 2 },
  { pattern: /^iowa\s+spirits\s+manufacturers$/i, score: 3 },
  { pattern: /distilled\s+spirit\s+specialty$/i, score: 4 },
  { pattern: /^neutral\s+grain\s+spirits/i, score: 5 }
];

/** Higher score = more specific spirit classification. */
const SPECIFIC_CATEGORY_PATTERNS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /\bgin/i, score: 100 },
  { pattern: /\bvodka/i, score: 100 },
  { pattern: /\bbourbon/i, score: 95 },
  { pattern: /\bscotch/i, score: 95 },
  { pattern: /\brye\b/i, score: 95 },
  { pattern: /\btennessee\b/i, score: 95 },
  { pattern: /\bcanadian\b.*whisk/i, score: 95 },
  { pattern: /\birish\b.*whisk/i, score: 95 },
  { pattern: /\bwhisk(e)y/i, score: 90 },
  { pattern: /\brum\b/i, score: 100 },
  { pattern: /\btequila\b/i, score: 100 },
  { pattern: /\bmezcal\b/i, score: 100 },
  { pattern: /\bbrandy\b|\bcognac\b/i, score: 100 },
  { pattern: /\bliqueur\b|\bcordial/i, score: 85 },
  { pattern: /\bschnapps\b/i, score: 85 },
  { pattern: /\btriple\s+sec\b/i, score: 85 }
];

export function iowaCategorySpecificity(categoryName: string): number {
  const text = String(categoryName ?? "").trim();
  if (!text) return -1;

  for (const { pattern, score } of GENERIC_CATEGORY_PATTERNS) {
    if (pattern.test(text)) return score;
  }

  let best = 50; // unknown non-generic Iowa category — mid preference
  for (const { pattern, score } of SPECIFIC_CATEGORY_PATTERNS) {
    if (pattern.test(text) && score > best) best = score;
  }
  return best;
}

export function isGenericIowaCategory(categoryName: string): boolean {
  return iowaCategorySpecificity(categoryName) < 50;
}

/**
 * Pick the most product-relevant Iowa row among duplicates.
 * Tie-break: higher specificity, then lexicographic category_name, then item_no.
 */
export function preferIowaRow<T extends { category_name: string; item_no: string }>(rows: T[]): T {
  if (rows.length === 0) {
    throw new Error("preferIowaRow requires at least one row");
  }
  return [...rows].sort((a, b) => {
    const spec = iowaCategorySpecificity(b.category_name) - iowaCategorySpecificity(a.category_name);
    if (spec !== 0) return spec;
    const cat = a.category_name.localeCompare(b.category_name);
    if (cat !== 0) return cat;
    return a.item_no.localeCompare(b.item_no);
  })[0]!;
}
