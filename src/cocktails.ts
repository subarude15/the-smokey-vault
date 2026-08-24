import { isTapEmpty, packagedCount } from "./catalog.js";
import { isBlocked } from "./speakeasy-shared.js";

export const SEASONS = ["All", "Spring", "Summer", "Fall", "Winter", "Holiday"] as const;
export type Season = typeof SEASONS[number];
export type Readiness = "ready" | "almost" | "missing";
export type IngredientState = "have" | "pantry" | "substitute" | "missing";

export type SubstituteOption = {
  name: string;
  brand: string;
  fill_level: number;
};

export type IngredientLine = {
  text: string;
  state: IngredientState;
  using?: string;
  /** Every on-shelf bottle that can stand in, when the match came from a substitution family. */
  substitute_options?: SubstituteOption[];
};

export type CocktailRecipe = {
  name: string;
  ingredients: string[];
  glassware: string;
  garnish: string;
  method: string;
  collection: string;
  season: Season;
  notes: string;
};

export const PANTRY_STAPLES = [
  "sugar", "sugar cube", "simple syrup", "sugar syrup", "syrup", "honey",
  "lemon", "lemon juice", "lime", "lime juice", "lime cordial",
  "soda", "soda water", "sparkling water", "club soda", "water",
  "salt", "egg", "egg white", "mint", "ice",
  "espresso", "coffee", "cream", "basil", "maple syrup"
];

const SUBSTITUTION_FAMILIES = [
  ["bourbon", "rye", "whiskey", "whisky", "tennessee", "scotch", "irish", "canadian", "japanese", "corn whiskey", "wheat whiskey"],
  ["tequila", "mezcal"],
  ["cognac", "brandy", "armagnac"],
  ["white rum", "light rum", "silver rum"],
  ["dark rum", "black rum", "navy rum"],
  ["rum", "gold rum", "amber rum", "agricole", "overproof", "cachaca", "cachaça"],
  ["champagne", "prosecco", "cava", "sparkling", "cremant", "crémant", "pet-nat", "pét-nat"],
  ["triple sec", "curacao", "curaçao", "cointreau", "grand marnier", "orange liqueur", "orange curacao"],
  ["sweet vermouth", "rosso vermouth", "red vermouth", "punt e mes"],
  ["dry vermouth", "extra dry vermouth", "blanc vermouth", "white vermouth"],
  ["bitters", "angostura", "peychaud", "peychaud's"],
  ["coffee liqueur", "kahlua", "kahlúa"],
  ["ginger beer", "ginger ale"]
];

export function spiritOnShelf(item: Record<string, unknown> | null | undefined): boolean {
  if (!item) return false;
  const fill = Number(item.fill_level ?? 0);
  const raw = item.stock_count;
  const stock = raw == null || String(raw).trim() === "" ? 1 : Math.max(0, Math.floor(Number(raw)) || 0);
  return fill > 1 || stock > 1;
}

export function wineOnShelf(item: Record<string, unknown> | null | undefined): boolean {
  if (!item) return false;
  return Number(item.bottle_count ?? 0) > 0;
}

export function packagedOnShelf(item: Record<string, unknown> | null | undefined): boolean {
  if (!item) return false;
  return packagedCount(item.count) > 0;
}

export function tapOnShelf(item: Record<string, unknown> | null | undefined): boolean {
  return Boolean(item) && !isTapEmpty(item);
}

export function isPlaceholderIngredients(value: unknown): boolean {
  const raw = String(value ?? "");
  return /base spirit|citrus or modifier|seasonal garnish/i.test(raw);
}

export function stripMeasure(ingredient: string): string {
  let value = ingredient.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
  for (let i = 0; i < 4; i++) {
    const next = value.replace(/^(?:\d+(?:\.\d+)?\s*(?:ml|cl|oz|tsp|tbsp|dashes?|drops?|sprigs?|cubes?|dash|splash)?\s*)/i, "");
    if (next === value) break;
    value = next.trim();
  }
  return value.replace(/^(?:fresh|a|an|the)\s+/i, "").trim();
}

export function ingredientOptions(normalized: string): string[] {
  return normalized.split(/\s+or\s+/).map((part) => part.trim()).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasWord(haystack: string, needle: string): boolean {
  const token = needle.trim().toLowerCase();
  if (token.length < 3) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(token)}(?:[^a-z0-9]|$)`).test(haystack.toLowerCase());
}

function fold(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function bottleLabel(item: Record<string, unknown>): string {
  const name = String(item.name ?? item.batch_name ?? item.varietal ?? "").trim();
  const maker = String(item.brand ?? item.producer ?? item.maker ?? "").trim();
  if (name && maker && !name.toLowerCase().includes(maker.toLowerCase())) return `${maker} ${name}`;
  return name || maker || String(item.category ?? item.type ?? "Bottle");
}

function bottleHaystack(item: Record<string, unknown>): string {
  const category = fold(item.category);
  const sub = fold(item.sub_category);
  const extras: string[] = [];
  if (category === "rum" && sub) extras.push(`${sub} rum`);
  if (category === "whiskey" && sub) extras.push(sub.replace(/x/g, " "));
  if (category === "mixer" && sub) extras.push(sub);
  return [
    item.name, item.brand, item.producer, item.maker, item.brewery, item.brewery_batch,
    item.category, item.sub_category, item.type, item.style, item.varietal, ...extras
  ].map(fold).filter(Boolean).join(" ");
}

export type ShelfBottle = {
  label: string;
  haystack: string;
  kind: "spirit" | "wine" | "beer";
  name: string;
  brand: string;
  fill_level: number;
};

/** Percent of the container still available, so count-based stock reads as a full bottle. */
function shelfFillLevel(item: Record<string, unknown>): number {
  const fill = Number(item.fill_level);
  if (Number.isFinite(fill) && fill > 0) return Math.max(0, Math.min(100, Math.round(fill)));
  const kegSize = Number(item.keg_size_l);
  const remaining = Number(item.remaining_l);
  if (Number.isFinite(kegSize) && kegSize > 0 && Number.isFinite(remaining)) {
    return Math.max(0, Math.min(100, Math.round((remaining / kegSize) * 100)));
  }
  return 100;
}

function shelfBottle(item: Record<string, unknown>, kind: ShelfBottle["kind"]): ShelfBottle {
  return {
    label: bottleLabel(item),
    haystack: bottleHaystack(item),
    kind,
    name: String(item.name ?? item.batch_name ?? item.varietal ?? "").trim() || bottleLabel(item),
    brand: String(item.brand ?? item.producer ?? item.maker ?? item.brewery ?? "").trim(),
    fill_level: shelfFillLevel(item)
  };
}

export function buildShelf(
  spirits: Array<Record<string, unknown>> = [],
  wines: Array<Record<string, unknown>> = [],
  packaged: Array<Record<string, unknown>> = [],
  taps: Array<Record<string, unknown>> = []
): ShelfBottle[] {
  const shelf: ShelfBottle[] = [];
  for (const item of spirits) {
    if (isBlocked(item) || !spiritOnShelf(item)) continue;
    shelf.push(shelfBottle(item, "spirit"));
  }
  for (const item of wines) {
    if (isBlocked(item) || !wineOnShelf(item)) continue;
    shelf.push(shelfBottle(item, "wine"));
  }
  for (const item of packaged) {
    if (isBlocked(item) || !packagedOnShelf(item)) continue;
    shelf.push(shelfBottle(item, "beer"));
  }
  for (const item of taps) {
    if (isBlocked(item) || !tapOnShelf(item)) continue;
    const tapItem = { ...item, name: item.brewery_batch, brand: item.maker };
    shelf.push(shelfBottle(tapItem, "beer"));
  }
  return shelf;
}

function isPantry(normalized: string): boolean {
  return PANTRY_STAPLES.some((staple) => hasWord(normalized, staple));
}

function familyOf(token: string): string[] | null {
  const hay = token.toLowerCase();
  return SUBSTITUTION_FAMILIES.find((family) => family.some((member) => hasWord(hay, member) || hay === member)) ?? null;
}

const GENERIC_WORDS = new Set([
  "whiskey", "whisky", "liqueur", "juice", "wine", "soda", "syrup", "cream",
  "white", "gold", "dark", "dry", "sweet", "fresh", "aged", "bottle", "vermouth"
]);

function directMatch(option: string, bottle: ShelfBottle): boolean {
  if (hasWord(bottle.haystack, option)) return true;
  const words = option.split(/\s+/).filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
  return words.some((word) => hasWord(bottle.haystack, word));
}

function vermouthKind(value: string): "sweet" | "dry" | "any" | null {
  const hay = value.toLowerCase();
  if (!hasWord(hay, "vermouth")) return null;
  const sweet = hasWord(hay, "sweet") || hasWord(hay, "rosso") || hasWord(hay, "red") || hasWord(hay, "punt e mes");
  const dry = hasWord(hay, "dry") || hasWord(hay, "blanc") || hasWord(hay, "extra dry");
  if (sweet && !dry) return "sweet";
  if (dry && !sweet) return "dry";
  return "any";
}

function vermouthFamilies(option: string): string[][] {
  const kind = vermouthKind(option);
  if (!kind) return [];
  const sweet = SUBSTITUTION_FAMILIES.find((family) => family[0] === "sweet vermouth") ?? [];
  const dry = SUBSTITUTION_FAMILIES.find((family) => family[0] === "dry vermouth") ?? [];
  if (kind === "sweet") return [sweet];
  if (kind === "dry") return [dry];
  return [sweet, dry];
}

function substituteMatch(option: string, bottle: ShelfBottle): boolean {
  const needed = vermouthKind(option);
  if (needed) {
    const onShelf = vermouthKind(bottle.haystack);
    if (onShelf) return needed === "any" || onShelf === "any" || needed === onShelf;
    return vermouthFamilies(option).some((family) => family.some((member) => hasWord(bottle.haystack, member)));
  }
  const family = familyOf(option);
  if (!family) return false;
  return family.some((member) => hasWord(bottle.haystack, member));
}

function substituteOption(bottle: ShelfBottle): SubstituteOption {
  return { name: bottle.name || bottle.label, brand: bottle.brand, fill_level: bottle.fill_level };
}

export function matchIngredient(ingredient: string, shelf: ShelfBottle[]): IngredientLine {
  const normalized = stripMeasure(ingredient);
  if (!normalized) return { text: ingredient, state: "pantry" };
  if (isPantry(normalized)) return { text: ingredient, state: "pantry" };

  const options = ingredientOptions(normalized);
  let substitute: IngredientLine | undefined;
  for (const option of options) {
    const direct = shelf.find((bottle) => directMatch(option, bottle));
    if (direct) return { text: ingredient, state: "have", using: direct.label };
    if (!substitute) {
      const swapped = shelf.filter((bottle) => substituteMatch(option, bottle));
      if (swapped.length) {
        substitute = {
          text: ingredient,
          state: "substitute",
          using: swapped[0].label,
          substitute_options: swapped.map(substituteOption)
        };
      }
    }
  }
  return substitute ?? { text: ingredient, state: "missing" };
}

export function parseIngredients(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    // Plain list.
  }
  return value.split(/\n|;/).map((entry) => entry.trim()).filter(Boolean);
}

export function matchCocktail(cocktail: Record<string, unknown>, shelf: ShelfBottle[]): {
  ingredients: string[];
  lines: IngredientLine[];
  missing: string[];
  readiness: Readiness;
  has_substitutes: boolean;
} {
  const ingredients = parseIngredients(cocktail.ingredients);
  const lines = ingredients.map((ingredient) => matchIngredient(ingredient, shelf));
  const missing = lines.filter((line) => line.state === "missing").map((line) => line.text);
  const readiness: Readiness = missing.length === 0 ? "ready" : missing.length === 1 ? "almost" : "missing";
  const hasSubstitutes = lines.some((line) => Boolean(line.substitute_options?.length));
  return { ingredients, lines, missing, readiness, has_substitutes: hasSubstitutes };
}

export function compareCocktails(
  a: { readiness?: string; name?: unknown; collection?: unknown },
  b: { readiness?: string; name?: unknown; collection?: unknown }
): number {
  const rank = (value?: string) => value === "ready" ? 0 : value === "almost" ? 1 : 2;
  const readiness = rank(a.readiness) - rank(b.readiness);
  if (readiness !== 0) return readiness;
  const custom = (String(a.collection ?? "") === "Custom Cocktails" ? 0 : 1) - (String(b.collection ?? "") === "Custom Cocktails" ? 0 : 1);
  if (custom !== 0) return custom;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
}

export function currentSeason(date = new Date()): Exclude<Season, "All"> {
  const month = date.getMonth();
  if (month === 11 || month <= 1) return "Winter";
  if (month <= 4) return "Spring";
  if (month <= 7) return "Summer";
  return "Fall";
}

export function mixologistShelfSummary(shelf: ShelfBottle[]): Array<{ name: string; kind: string }> {
  return shelf.map((bottle) => ({ name: bottle.label, kind: bottle.kind }));
}

export function collectionGroup(collection: unknown): "Custom" | "Seasonal" | "Classics" {
  const value = String(collection ?? "");
  if (value === "Custom Cocktails") return "Custom";
  if (/seasonal/i.test(value)) return "Seasonal";
  return "Classics";
}
