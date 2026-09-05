/**
 * Packaged-beer name-search semantics (retrieval-only).
 *
 * Style aliases are equivalence concepts — never appended as AND tokens.
 * Diacritic folding / typo tolerance apply to brewery & product text only.
 * No Catalog.beer, UPC, or persistence coupling.
 */

export type BeerMatchClass =
  | "exact_identity"
  | "name_and_brewery"
  | "name"
  | "brewery_and_style"
  | "brewery_only"
  | "style_only"
  | "fuzzy"
  | "weak";

export type ParsedBeerQuery = {
  raw: string;
  folded: string;
  tokens: string[];
  styleConcepts: string[];
  nonStyleTokens: string[];
};

type StyleConcept = {
  id: string;
  aliases: string[];
};

/** Small, obvious style equivalence groups — not a full taxonomy. */
export const BEER_STYLE_CONCEPTS: StyleConcept[] = [
  {
    id: "dipa",
    aliases: ["double india pale ale", "imperial india pale ale", "double ipa", "imperial ipa", "dipa"]
  },
  {
    id: "neipa",
    aliases: ["new england ipa", "new england india pale ale", "hazy ipa", "neipa"]
  },
  {
    id: "west_coast_ipa",
    aliases: ["west coast india pale ale", "west coast ipa"]
  },
  {
    id: "ipa",
    aliases: ["india pale ale", "ipa"]
  },
  {
    id: "pale_ale",
    aliases: ["pale ale"]
  },
  {
    id: "pilsner",
    aliases: ["pilsner", "pils"]
  },
  {
    id: "hefeweizen",
    aliases: ["hefeweizen", "hefe"]
  },
  {
    id: "wheat",
    aliases: ["wheat beer", "wheat"]
  },
  {
    id: "stout",
    aliases: ["stout"]
  },
  {
    id: "porter",
    aliases: ["porter"]
  },
  {
    id: "lager",
    aliases: ["lager"]
  },
  {
    id: "sour",
    aliases: ["sour"]
  },
  {
    id: "kolsch",
    aliases: ["kolsch", "kölsch"]
  }
];

const SHORT_NO_FUZZY = new Set([
  "ipa",
  "ale",
  "gin",
  "rum",
  "red",
  "rye",
  "pils",
  "dipa",
  "neipa",
  "sour",
  "hefe"
]);

const MATCH_CLASS_SCORE: Record<BeerMatchClass, number> = {
  exact_identity: 1000,
  name_and_brewery: 820,
  name: 660,
  brewery_and_style: 460,
  brewery_only: 240,
  style_only: 110,
  fuzzy: 70,
  weak: 15
};

const SOURCE_SCORE: Record<string, number> = {
  vault: 40,
  beer_cache: 28,
  catalog_beer: 18,
  cache: 12,
  openfoodfacts: 8,
  cola_cloud: 5,
  fwgs: 5
};

type AliasEntry = { id: string; alias: string };

function buildAliasIndex(): AliasEntry[] {
  const out: AliasEntry[] = [];
  for (const concept of BEER_STYLE_CONCEPTS) {
    for (const alias of concept.aliases) {
      out.push({ id: concept.id, alias: foldBeerText(alias) });
    }
  }
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

export function foldBeerText(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[_/.,()+]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STYLE_ALIAS_INDEX = buildAliasIndex();

export function beerTextTokens(value: string): string[] {
  return foldBeerText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function parseBeerQuery(raw: string): ParsedBeerQuery {
  const folded = foldBeerText(raw);
  let remaining = folded ? ` ${folded} ` : " ";
  const styleConcepts: string[] = [];

  for (const entry of STYLE_ALIAS_INDEX) {
    if (styleConcepts.includes(entry.id)) continue;
    const padded = ` ${entry.alias} `;
    if (!remaining.includes(padded)) continue;
    styleConcepts.push(entry.id);
    remaining = remaining.split(padded).join(" ");
  }

  const nonStyleTokens = remaining
    .trim()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return {
    raw,
    folded,
    tokens: beerTextTokens(folded),
    styleConcepts,
    nonStyleTokens
  };
}

export function beerProductFields(product: Record<string, unknown>) {
  const name = foldBeerText(
    String(product.name ?? product.product_name ?? product.batch_name ?? product.brewery_batch ?? "")
  );
  const brewery = foldBeerText(
    String(product.brewery ?? product.brand ?? product.producer ?? product.maker ?? "")
  );
  const style = foldBeerText(String(product.style ?? product.category ?? product.sub_category ?? ""));
  return {
    name,
    brewery,
    style,
    nameTokens: beerTextTokens(name),
    breweryTokens: beerTextTokens(brewery),
    styleTokens: beerTextTokens(style),
    all: foldBeerText(`${name} ${brewery} ${style}`)
  };
}

export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  if (Math.abs(al - bl) > 1) return 2;

  const dp: number[][] = Array.from({ length: al + 1 }, () => Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= bl; j += 1) dp[0]![j] = j;

  for (let i = 1; i <= al; i += 1) {
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
      }
    }
  }
  return dp[al]![bl]!;
}

function isNumericToken(token: string) {
  return /^\d+$/.test(token);
}

function allowsFuzzy(token: string) {
  return token.length >= 5 && !isNumericToken(token) && !SHORT_NO_FUZZY.has(token);
}

function fuzzyTokenHit(token: string, candidateTokens: string[]) {
  if (!allowsFuzzy(token)) return false;
  for (const candidate of candidateTokens) {
    if (!allowsFuzzy(candidate)) continue;
    if (damerauLevenshtein(token, candidate) <= 1) return true;
  }
  return false;
}

export function styleConceptPresent(conceptId: string, hay: string): boolean {
  const concept = BEER_STYLE_CONCEPTS.find((entry) => entry.id === conceptId);
  if (!concept) return false;
  const paddedHay = ` ${foldBeerText(hay)} `;
  return concept.aliases.some((alias) => paddedHay.includes(` ${foldBeerText(alias)} `));
}

function tokenSatisfied(token: string, fields: ReturnType<typeof beerProductFields>): boolean {
  if (fields.all.includes(token)) return true;
  if (isNumericToken(token)) return false;
  const pool = [...fields.nameTokens, ...fields.breweryTokens, ...fields.styleTokens];
  return fuzzyTokenHit(token, pool);
}

/** Whether a candidate should enter the beer result pool for this query. */
export function matchesBeerQuery(product: Record<string, unknown>, parsed: ParsedBeerQuery): boolean {
  if (!parsed.styleConcepts.length && !parsed.nonStyleTokens.length) return false;
  const fields = beerProductFields(product);
  const styleHay = `${fields.style} ${fields.name}`;

  for (const conceptId of parsed.styleConcepts) {
    if (!styleConceptPresent(conceptId, styleHay) && !styleConceptPresent(conceptId, fields.all)) {
      return false;
    }
  }

  for (const token of parsed.nonStyleTokens) {
    if (!tokenSatisfied(token, fields)) return false;
  }
  return true;
}

function coverage(tokens: string[], candidateTokens: string[]) {
  if (!tokens.length) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (candidateTokens.some((part) => part === token || part.startsWith(token) || token.startsWith(part))) {
      hits += 1;
      continue;
    }
    if (fuzzyTokenHit(token, candidateTokens)) hits += 0.55;
  }
  return hits / tokens.length;
}

export function classifyBeerMatch(product: Record<string, unknown>, parsed: ParsedBeerQuery): BeerMatchClass {
  const fields = beerProductFields(product);
  if (!matchesBeerQuery(product, parsed)) return "weak";

  const identity = foldBeerText(`${fields.brewery} ${fields.name}`);
  if (parsed.folded && (identity === parsed.folded || fields.name === parsed.folded)) {
    return "exact_identity";
  }
  if (parsed.folded.length >= 8 && (identity.includes(parsed.folded) || fields.name.includes(parsed.folded))) {
    return "exact_identity";
  }

  const breweryCov = coverage(parsed.nonStyleTokens, fields.breweryTokens);
  const nameCov = coverage(parsed.nonStyleTokens, fields.nameTokens);
  const stylesOk =
    !parsed.styleConcepts.length ||
    parsed.styleConcepts.every((id) => styleConceptPresent(id, `${fields.style} ${fields.name}`));
  const usedFuzzy = parsed.nonStyleTokens.some(
    (token) => !fields.all.includes(token) && fuzzyTokenHit(token, [...fields.nameTokens, ...fields.breweryTokens])
  );

  const breweryPart = parsed.nonStyleTokens.slice(0, 1);
  const productPart = parsed.nonStyleTokens.slice(1);
  const breweryPartCov = breweryPart.length ? coverage(breweryPart, fields.breweryTokens) : 0;
  const productPartCov = productPart.length ? coverage(productPart, fields.nameTokens) : 0;

  if (productPart.length && productPartCov >= 0.99 && breweryPartCov >= 0.99) return "name_and_brewery";
  if (nameCov >= 0.99 && breweryCov >= 0.45 && parsed.nonStyleTokens.length >= 2) return "name_and_brewery";
  if (productPart.length && productPartCov >= 0.99) return "name";
  if (nameCov >= 0.99) return "name";
  if (breweryPartCov >= 0.99 && stylesOk && parsed.styleConcepts.length) return "brewery_and_style";
  if (breweryCov >= 0.99 && stylesOk && parsed.styleConcepts.length && productPartCov < 0.4) {
    return "brewery_and_style";
  }
  if (breweryCov >= 0.99 && productPartCov < 0.35) return "brewery_only";
  if (!parsed.nonStyleTokens.length && stylesOk && parsed.styleConcepts.length) return "style_only";
  if (usedFuzzy) return "fuzzy";
  if (breweryCov >= 0.5 && stylesOk && parsed.styleConcepts.length) return "brewery_and_style";
  return "weak";
}

export function scoreBeerHit(
  product: Record<string, unknown>,
  parsed: ParsedBeerQuery,
  source: string
): number {
  const fields = beerProductFields(product);
  const matchClass = classifyBeerMatch(product, parsed);
  let score = MATCH_CLASS_SCORE[matchClass] + (SOURCE_SCORE[source] ?? 0);

  const nameCov = coverage(parsed.nonStyleTokens, fields.nameTokens);
  const breweryCov = coverage(parsed.nonStyleTokens, fields.breweryTokens);
  score += Math.round(nameCov * 120);
  score += Math.round(breweryCov * 70);

  for (const conceptId of parsed.styleConcepts) {
    if (styleConceptPresent(conceptId, `${fields.style} ${fields.name}`)) score += 40;
  }

  if (parsed.nonStyleTokens.length >= 2) {
    const productToken = parsed.nonStyleTokens[parsed.nonStyleTokens.length - 1]!;
    if (fields.name.includes(productToken) || fields.nameTokens.includes(productToken)) score += 100;
    else if (fields.brewery.includes(productToken) && !fields.name.includes(productToken)) score -= 90;
  }

  if (parsed.folded && fields.name === parsed.folded) score += 60;
  if (parsed.folded && foldBeerText(`${fields.brewery} ${fields.name}`) === parsed.folded) score += 80;

  const exactNonStyle = parsed.nonStyleTokens.filter((token) => fields.all.includes(token)).length;
  const fuzzyNonStyle = parsed.nonStyleTokens.length - exactNonStyle;
  score += exactNonStyle * 15;
  score -= fuzzyNonStyle * 25;

  if (matchClass === "brewery_only") score -= 40;
  if (matchClass === "style_only") score -= 30;

  return score;
}

export function rankBeerSearchHits<T extends { source: string; product: Record<string, unknown> }>(
  hits: T[],
  parsed: ParsedBeerQuery
): T[] {
  return hits
    .map((hit, index) => ({
      hit,
      index,
      score: matchesBeerQuery(hit.product, parsed)
        ? scoreBeerHit(hit.product, parsed, hit.source)
        : -1000 + index
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.hit);
}
