/**
 * PR154 — deterministic cocktail-image identity model.
 *
 * The PR129 gate was effectively "exact normalized name only", which rejected
 * safe canonical variations like "Gin Basil Smash" for a requested "Basil Smash".
 * This module keeps that strictness for genuinely different drinks while adding
 * two safe, deterministic paths:
 *   1. exact normalized name (strongest),
 *   2. base-spirit alias confirmed by the drink's own ingredients (strong),
 * and rejects everything else — any meaningful modifier token (strawberry,
 * smoked, spicy, …) or a different/unconfirmed base spirit rejects the candidate.
 *
 * No AI/LLM, no fuzzy substring acceptance, no network.
 */

/** Base spirits eligible for an optional prefix/suffix name alias. */
const BASE_SPIRITS = new Set([
  "gin", "vodka", "rum", "whiskey", "whisky", "bourbon", "rye", "scotch",
  "tequila", "mezcal", "brandy", "cognac", "pisco", "cachaca", "sake",
  "aquavit", "absinthe", "genever"
]);

/** Whiskey-family spirits all corroborate a generic "whiskey" alias token. */
const WHISKEY_FAMILY = new Set(["whiskey", "whisky", "bourbon", "rye", "scotch"]);

/**
 * Ingredient tokens that mark a modified/flavored variant. If a candidate's
 * ingredients add one of these and the requested drink does not have it, the
 * candidate is a different drink (e.g. Strawberry Basil Smash).
 */
const MODIFIER_INGREDIENTS = new Set([
  "strawberry", "strawberries", "raspberry", "raspberries", "blackberry", "blackberries",
  "blueberry", "blueberries", "watermelon", "pineapple", "mango", "peach", "peaches",
  "coconut", "elderflower", "cucumber", "jalapeno", "jalapeño", "cranberry", "pomegranate",
  "passionfruit", "lavender", "hibiscus", "rhubarb", "apricot", "fig", "plum"
]);

/** Quantity/unit/prep words to drop when extracting ingredient content words. */
const INGREDIENT_STOPWORDS = new Set([
  "ml", "cl", "oz", "ounce", "ounces", "dash", "dashes", "tsp", "teaspoon", "teaspoons",
  "tbsp", "tablespoon", "tablespoons", "cube", "cubes", "part", "parts", "splash", "splashes",
  "barspoon", "barspoons", "drop", "drops", "cup", "cups", "g", "gram", "grams", "shot", "shots",
  "fresh", "of", "or", "and", "a", "an", "the", "to", "top", "with", "ice", "cold", "chilled",
  "good", "quality", "leaf", "leaves", "large", "small", "ripe", "optional", "garnish",
  "twist", "wedge", "wheel", "peel", "slice", "slices", "pinch", "handful", "few", "chunk", "chunks"
]);

/** Punctuation/case-normalized cocktail identity token string. */
export function normalizeCocktailName(name: string): string {
  return String(name ?? "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Soften a page title into a candidate drink identity by stripping site branding
 * and generic recipe boilerplate — never drink modifiers. Site separators
 * `|`, `·`, `•` may drop publisher branding; `-` / `–` / `—` are preserved
 * because they often carry modifiers ("Old Fashioned – Smoked Version").
 */
export function softTitleCocktailIdentity(title: string): string {
  const raw = String(title ?? "").trim();
  const main = (raw.split(/\s*[|·•]\s*/)[0] ?? raw).trim();
  let n = normalizeCocktailName(main);
  n = n.replace(/^(the|a|an)\s+/, "");
  for (let i = 0; i < 3; i++) {
    const next = n
      .replace(/^(how to make|make|best|classic|homemade|easy)\s+/, "")
      .replace(/\s+(recipe|cocktail|drink|cocktails)$/, "")
      .trim();
    if (next === n) break;
    n = next;
  }
  return n;
}

/** Exact identity only (after normalize). "Smoked Old Fashioned" ≠ "Old Fashioned". */
export function cocktailNamesMatchExact(candidate: string, target: string): boolean {
  const a = normalizeCocktailName(candidate);
  const b = normalizeCocktailName(target);
  return Boolean(a) && a === b;
}

function tokens(normalized: string): string[] {
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

/** Content words from ingredient strings, with quantities/units/prep stripped. */
export function ingredientContentWords(ingredients: readonly string[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of ingredients ?? []) {
    const cleaned = String(raw ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z\s]+/g, " ");
    for (const word of cleaned.split(/\s+/)) {
      if (!word || INGREDIENT_STOPWORDS.has(word)) continue;
      out.add(word);
    }
  }
  return out;
}

/** Base spirits present in the ingredients (whiskey-family also implies "whiskey"). */
export function baseSpiritsInIngredients(ingredients: readonly string[] | null | undefined): Set<string> {
  const words = ingredientContentWords(ingredients);
  const base = new Set<string>();
  for (const word of words) if (BASE_SPIRITS.has(word)) base.add(word);
  if ([...base].some((spirit) => WHISKEY_FAMILY.has(spirit))) base.add("whiskey");
  return base;
}

function modifierIngredients(ingredients: readonly string[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const word of ingredientContentWords(ingredients)) {
    if (MODIFIER_INGREDIENTS.has(word)) out.add(word);
  }
  return out;
}

/** Primary base spirit for query planning (first base spirit in ingredient order). */
export function primaryBaseSpirit(ingredients: readonly string[] | null | undefined): string {
  for (const raw of ingredients ?? []) {
    for (const word of ingredientContentWords([raw])) {
      if (BASE_SPIRITS.has(word)) return word;
    }
  }
  return "";
}

export type CocktailIdentityTier = "exact" | "alias" | "reject";
export type CocktailIdentityResult = { tier: CocktailIdentityTier; reason?: string };

/**
 * Classify whether `candidate` names the same cocktail as `target`.
 *
 * - identical normalized names → exact
 * - the only name-token difference is base-spirit tokens that the requested
 *   drink's ingredients actually contain → alias (e.g. Basil Smash ↔ Gin Basil
 *   Smash when the drink has gin), unless the candidate's ingredients add a
 *   flavor modifier the target lacks
 * - anything else (meaningful modifier token, different/unconfirmed base
 *   spirit, disjoint names) → reject
 */
export function classifyCocktailIdentity(input: {
  target: string;
  candidate: string;
  targetIngredients?: readonly string[];
  candidateIngredients?: readonly string[];
}): CocktailIdentityResult {
  const targetNorm = normalizeCocktailName(input.target);
  const candidateNorm = softTitleCocktailIdentity(input.candidate);
  if (!targetNorm || !candidateNorm) return { tier: "reject", reason: "empty_name" };

  // 1. Determine the name-based tier (exact, valid base-spirit alias, or reject).
  let nameTier: "exact" | "alias" | null = null;
  if (targetNorm === candidateNorm) {
    nameTier = "exact";
  } else {
    const targetSet = new Set(tokens(targetNorm));
    const candidateSet = new Set(tokens(candidateNorm));
    const diff = [
      ...[...candidateSet].filter((t) => !targetSet.has(t)),
      ...[...targetSet].filter((t) => !candidateSet.has(t))
    ];
    if (diff.length === 0) {
      nameTier = "exact";
    } else {
      // Every differing token must be a base spirit the requested drink truly uses.
      const confirmedBase = baseSpiritsInIngredients(input.targetIngredients);
      const allDiffAreConfirmedBaseSpirits = diff.every(
        (token) => BASE_SPIRITS.has(token) && confirmedBase.has(token)
      );
      if (allDiffAreConfirmedBaseSpirits) nameTier = "alias";
    }
  }
  if (!nameTier) return { tier: "reject", reason: "name_modifier" };

  // 2. Ingredient-variant guard — applies to BOTH exact and alias identities.
  // A clean/matching name still rejects when the candidate's ingredients add a
  // known flavor modifier the target lacks (e.g. an exact "Basil Smash" page
  // whose recipe includes strawberry).
  if (input.candidateIngredients) {
    const targetMods = modifierIngredients(input.targetIngredients);
    for (const mod of modifierIngredients(input.candidateIngredients)) {
      if (!targetMods.has(mod)) return { tier: "reject", reason: "ingredient_variant" };
    }
  }

  return { tier: nameTier };
}

export function cocktailIdentityAccepted(result: CocktailIdentityResult): boolean {
  return result.tier === "exact" || result.tier === "alias";
}

/**
 * Bounded, deterministic query plan: exact name first, then a base-spirit alias
 * query, then an ingredient-assisted query. Deduplicated; at most three.
 */
export function buildCocktailImageQueryPlan(
  name: string,
  ingredients: readonly string[] | null | undefined,
  baseQuery: string
): string[] {
  const plan: string[] = [];
  const push = (query: string) => {
    const q = query.trim();
    if (q && !plan.includes(q)) plan.push(q);
  };
  push(baseQuery);

  const nameTokens = new Set(tokens(normalizeCocktailName(name)));
  const base = primaryBaseSpirit(ingredients);
  if (base && !nameTokens.has(base)) {
    const spirit = base.charAt(0).toUpperCase() + base.slice(1);
    push(`${spirit} ${name} cocktail recipe`);
  }

  const signature: string[] = [];
  if (base) signature.push(base);
  for (const word of ingredientContentWords(ingredients)) {
    if (signature.length >= 2) break;
    if (!BASE_SPIRITS.has(word) && !nameTokens.has(word) && word.length > 2 && !signature.includes(word)) {
      signature.push(word);
    }
  }
  if (signature.length) push(`${name} ${signature.join(" ")} cocktail`);

  return plan.slice(0, 3);
}
