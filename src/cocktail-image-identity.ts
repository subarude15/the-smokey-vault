/**
 * PR154/PR155 — deterministic cocktail-image identity model.
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
  "passionfruit", "lavender", "hibiscus", "rhubarb", "apricot", "fig", "plum",
  "smoked", "smoky", "spicy", "dirty", "frozen", "blended", "virgin", "mocktail", "barrel",
  "toasted", "grilled", "tropical", "chocolate", "coffee", "espresso"
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
  // Pipe/dot/bullet may drop publisher branding; hyphens are preserved because
  // they often carry modifiers ("Old Fashioned – Smoked Version").
  const main = (raw.split(/\s*[|·•]\s*/)[0] ?? raw).trim();
  let n = normalizeCocktailName(main);
  for (let i = 0; i < 4; i++) {
    const next = n
      .replace(/^(the|a|an)\s+/, "")
      .replace(/^(how to make|how to|make|best|classic|homemade|easy|perfect|original|traditional|ultimate)\s+/, "")
      .replace(/\s+(recipe|cocktail|drink|cocktails|guide|specs|ingredients)$/, "")
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

/** Weak words that should not become signature search terms. */
const WEAK_SIGNATURE_WORDS = new Set([
  ...INGREDIENT_STOPWORDS,
  "juice", "syrup", "sugar", "water", "soda", "tonic", "club", "simple", "rich", "demerara",
  "egg", "white", "yolk", "cream", "milk", "honey", "salt", "pepper"
]);

/** Prefer these non-base identity words when building ingredient-assisted queries. */
const STRONG_SIGNATURE_WORDS = [
  "champagne", "prosecco", "cava", "sparkling",
  "campari", "vermouth", "cointreau", "curacao", "maraschino", "benedictine", "aperol",
  "lemon", "lime", "orange", "grapefruit",
  "basil", "mint", "rosemary", "thyme", "bitters"
];

/**
 * Descriptive SERP boilerplate / own-spirit tokens that do not imply a flavored
 * derivative when they appear around the drink name in a search title.
 */
const SEARCH_TITLE_GENERIC_TOKENS = new Set([
  "classic", "homemade", "easy", "best", "perfect", "original", "traditional", "simple",
  "bar", "iba", "recipe", "cocktail", "drink", "drinks", "guide", "make", "made", "with",
  "and", "the", "a", "an", "how", "to", "for", "from", "by", "of", "official", "ultimate",
  "version", "style", "specs", "spec", "ingredients", "instructions", "steps", "video",
  "blog", "serious", "eats", "liquor", "com", "punch", "diffords", "difford", "nytimes",
  "cooking", "epicurious", "kitchn", "food", "wine", "bbc", "good", "imbibe", "party",
  "app", "champagne", "sparkling", "prosecco", "cava", "lemon", "lime", "orange", "juice",
  "syrup", "sugar", "bitters", "ice", "garnish", "glass", "coupe", "flute", "highball",
  "rocks", "gin", "vodka", "rum", "whiskey", "whisky", "bourbon", "rye", "tequila", "mezcal",
  "brandy", "cognac", "campari", "vermouth", "cointreau", "basil", "mint", "history",
  "about", "real", "true", "famous", "iconic", "standard", "house"
]);

/**
 * Deterministic signature words for image search (PR155).
 * Prefer base spirit + sparkling/citrus/amaro identity over juice/syrup/sugar.
 */
export function signatureIngredientsForSearch(
  ingredients: readonly string[] | null | undefined,
  name = ""
): string[] {
  const nameTokens = new Set(tokens(normalizeCocktailName(name)));
  const words = ingredientContentWords(ingredients);
  const out: string[] = [];
  const push = (word: string) => {
    if (!word || nameTokens.has(word) || out.includes(word)) return;
    out.push(word);
  };

  const base = primaryBaseSpirit(ingredients);
  if (base) push(base);

  for (const strong of STRONG_SIGNATURE_WORDS) {
    if (out.length >= 3) break;
    if (words.has(strong) && !WEAK_SIGNATURE_WORDS.has(strong)) push(strong);
  }

  for (const word of words) {
    if (out.length >= 3) break;
    if (BASE_SPIRITS.has(word) || WEAK_SIGNATURE_WORDS.has(word)) continue;
    push(word);
  }
  return out.slice(0, 3);
}

/**
 * Cheap SERP pre-filter helper (PR155).
 *
 * Returns true only when the title clearly looks like a flavored/numbered
 * derivative of the requested drink. Descriptive titles such as
 * "Classic French 75 Cocktail Recipe" or "How to Make a French 75" are NOT
 * derivatives — they should reach the stronger page-level identity gate.
 */
export function isDerivativeCocktailSearchTitle(
  title: string,
  cocktailName: string,
  targetIngredients: readonly string[] = []
): boolean {
  const target = normalizeCocktailName(cocktailName);
  if (!target) return false;
  if (cocktailIdentityAccepted(classifyCocktailIdentity({
    target: cocktailName,
    candidate: title,
    targetIngredients
  }))) {
    return false;
  }

  const titleId = softTitleCocktailIdentity(title);

  // Numbered cocktail variants: "French 75" must not accept "French 76" / "French 95".
  const targetNumbered = target.match(/^(.+?)\s+(\d+)$/);
  if (targetNumbered) {
    const stem = targetNumbered[1];
    const targetNum = targetNumbered[2];
    const titleNumbered = titleId.match(new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)$`));
    if (titleNumbered && titleNumbered[1] !== targetNum) return true;
    // Also catch "Elderflower French 76" style after soft-title cleanup leaves stem+number.
    const embedded = titleId.match(new RegExp(`(?:^|\\s)${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)(?:\\s|$)`));
    if (embedded && embedded[1] !== targetNum) return true;
  }

  if (!titleId.includes(target)) return false;

  const extras = titleId.replace(target, " ").trim().split(/\s+/).filter(Boolean);
  const confirmedBase = baseSpiritsInIngredients(targetIngredients);
  for (const token of extras) {
    if (SEARCH_TITLE_GENERIC_TOKENS.has(token)) continue;
    if (BASE_SPIRITS.has(token) && (confirmedBase.size === 0 || confirmedBase.has(token))) continue;
    if (MODIFIER_INGREDIENTS.has(token)) return true;
    if (/^\d+$/.test(token) && !tokens(target).includes(token)) return true;
  }
  return false;
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

  const signature = signatureIngredientsForSearch(ingredients, name);
  if (signature.length) push(`${name} ${signature.join(" ")} cocktail`);

  return plan.slice(0, 3);
}
