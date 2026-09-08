/** Presentation helpers for cocktail `method` text (PR137). Never invents steps. */

export type CocktailInstructions =
  | { kind: "empty" }
  | { kind: "method"; label: string }
  | { kind: "prose"; text: string }
  | { kind: "steps"; steps: string[] };

function stripStepNumber(text: string): string {
  return text.replace(/^\d+[\.)]\s+/, "").trim();
}

function splitNumberedSteps(text: string): string[] | null {
  const parts = text
    .split(/(?=\d+[\.)]\s+)/)
    .map((part) => stripStepNumber(part.trim()))
    .filter(Boolean);
  // Require at least two numbered markers in the original string.
  const markers = text.match(/\d+[\.)]\s+/g);
  if (!markers || markers.length < 2 || parts.length < 2) return null;
  return parts;
}

function splitNewlineSteps(text: string): string[] | null {
  if (!/[\n\r]/.test(text)) return null;
  const lines = text.split(/\r?\n/).map((line) => stripStepNumber(line.trim())).filter(Boolean);
  return lines.length >= 2 ? lines : null;
}

/**
 * Explicit allowlist of genuine bar technique labels. Only these are treated as
 * bare method chips eligible for generated steps; anything else (e.g. "Shake with
 * ice and strain into a coupe.") is real prose and must be preserved as-is.
 */
const COCKTAIL_METHOD_LABELS = new Set([
  "build",
  "shake",
  "stir",
  "muddle",
  "blend",
  "layer",
  "throw",
  "roll",
  "swizzle",
  "whip",
  "shake and top",
  "shake hard and top",
  "muddle and build",
  "muddle and shake",
  "stir and strain",
  "shake and strain",
  "dry shake",
  "reverse dry shake",
  "double strain"
]);

function normalizeMethodLabel(text: string): string {
  return text.trim().toLowerCase().replace(/[.\s]+$/, "").replace(/\s+/g, " ");
}

/** True only for recognized short technique labels (Build / Shake / Stir / …). */
export function isCocktailMethodLabel(text: string): boolean {
  const value = text.trim();
  if (!value || /[\n\r]/.test(value)) return false;
  if (/\d+[.)]\s+/.test(value)) return false;
  return COCKTAIL_METHOD_LABELS.has(normalizeMethodLabel(value));
}

/** Card/header summary: only keep compact method labels. */
export function cocktailMethodSummary(method: unknown): string {
  const text = String(method ?? "").trim();
  if (!text) return "";
  return isCocktailMethodLabel(text) ? text : "";
}

export function parseCocktailInstructions(method: unknown): CocktailInstructions {
  const text = String(method ?? "").trim();
  if (!text) return { kind: "empty" };

  const numbered = splitNumberedSteps(text);
  if (numbered) return { kind: "steps", steps: numbered };

  const newlines = splitNewlineSteps(text);
  if (newlines) return { kind: "steps", steps: newlines };

  if (isCocktailMethodLabel(text)) return { kind: "method", label: text };

  return { kind: "prose", text };
}

/* -------------------------------------------------------------------------- */
/* Built-in cocktail step generation (PR145)                                  */
/*                                                                            */
/* Seeded/classic cocktails carry only a short technique label (Build, Shake, */
/* Stir, …). Rather than leaving the recipe as a bare method chip, we derive  */
/* consistent, practical preparation steps from the structured fields already */
/* present (method + glassware + garnish). AI-found and custom recipes that    */
/* already contain full prose/numbered instructions are used as-is and never   */
/* overwritten by generation.                                                  */
/* -------------------------------------------------------------------------- */

export type CocktailRecipeForSteps = {
  method?: unknown;
  glassware?: unknown;
  garnish?: unknown;
  ingredients?: unknown;
};

export type ResolvedCocktailInstructions =
  | { kind: "steps"; steps: string[]; methodLabel: string | null; generated: boolean }
  | { kind: "prose"; text: string }
  | { kind: "empty" };

function normalizeIngredientList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry).trim()).filter(Boolean);
  } catch {
    // plain list
  }
  return raw.split(/\n|;/).map((entry) => entry.trim()).filter(Boolean);
}

/** Turn a glassware label into a readable vessel phrase ("Rocks" → "rocks glass"). */
export function cocktailGlassPhrase(glassware: unknown): string {
  const raw = String(glassware ?? "").trim();
  if (!raw) return "glass";
  const lower = raw.toLowerCase();
  if (/(mug|flute|coupe|cup|hurricane|pilsner|snifter|tiki|goblet)/.test(lower)) return lower;
  if (lower.includes("glass")) return lower;
  return `${lower} glass`;
}

function garnishStep(garnish: unknown): string {
  const value = String(garnish ?? "").trim();
  if (!value || /^none$/i.test(value)) return "Serve.";
  const lead = value.charAt(0).toLowerCase() + value.slice(1);
  return `Garnish with ${lead} and serve.`;
}

/**
 * Glasses served "up"/neat with no ice in the serving vessel (flute, coupe,
 * martini, Nick & Nora). Build/top templates must not add ice to these.
 */
function isUpServedGlass(glassware: unknown): boolean {
  return /\b(flute|coupe|martini|nick)\b/.test(String(glassware ?? "").toLowerCase());
}

type MethodCategory = "muddle" | "shakeTop" | "shake" | "stir" | "build" | "generic";

function methodCategory(method: string): MethodCategory {
  const value = method.toLowerCase();
  if (value.includes("muddle")) return "muddle";
  if (value.includes("shake") && value.includes("top")) return "shakeTop";
  if (value.includes("shake")) return "shake";
  if (value.includes("stir")) return "stir";
  if (value.includes("build")) return "build";
  return "generic";
}

/** Coffee-flavored liqueurs are cold ingredients, not the hot beverage. */
const COFFEE_LIQUEUR = /coffee liqueur|coffee liquor|espresso liqueur|coffee bean|kahl|tia maria/;

/** True when a single ingredient line genuinely represents a hot beverage/liquid. */
function ingredientImpliesHot(line: string): boolean {
  const value = line.toLowerCase();
  if (/\bhot water\b|\bboiling\b|\bhot tea\b|\bhot milk\b|\bhot cider\b/.test(value)) return true;
  // "coffee" only counts as hot when it is the beverage — not a coffee liqueur.
  if (/\bcoffee\b/.test(value)) return !COFFEE_LIQUEUR.test(value);
  return false;
}

function isHotBuild(ingredients: string[]): boolean {
  return ingredients.some(ingredientImpliesHot);
}

/**
 * Deterministic, practical preparation steps derived from a cocktail's method,
 * glassware, and garnish. Always returns at least two steps.
 */
export function buildCocktailSteps(recipe: CocktailRecipeForSteps): string[] {
  const glass = cocktailGlassPhrase(recipe.glassware);
  const ingredients = normalizeIngredientList(recipe.ingredients);
  const method = String(recipe.method ?? "").trim();
  const garnish = garnishStep(recipe.garnish);

  switch (method ? methodCategory(method) : "generic") {
    case "shake":
      return [
        "Add the measured ingredients to a shaker with ice.",
        "Shake hard until well chilled.",
        `Strain into a chilled ${glass}.`,
        garnish
      ];
    case "stir":
      return [
        "Add the measured ingredients to a mixing glass with ice.",
        "Stir until well chilled.",
        `Strain into a ${glass}.`,
        garnish
      ];
    case "shakeTop":
      return [
        "Add the non-sparkling ingredients to a shaker with ice.",
        "Shake until well chilled.",
        isUpServedGlass(recipe.glassware)
          ? `Strain into a chilled ${glass}.`
          : `Strain into a ${glass} over fresh ice.`,
        "Top with the sparkling ingredient (soda, tonic, or sparkling wine).",
        garnish
      ];
    case "muddle":
      return [
        `Muddle the fruit, herbs, or sugar in the ${glass}.`,
        "Fill with ice and add the remaining ingredients.",
        "Churn or stir gently to combine.",
        garnish
      ];
    case "build":
      if (isHotBuild(ingredients)) {
        return [
          `Add the measured ingredients to a warmed ${glass}.`,
          "Stir gently to combine and serve hot.",
          garnish
        ];
      }
      if (isUpServedGlass(recipe.glassware)) {
        return [
          `Add the measured ingredients to a chilled ${glass}.`,
          "Stir gently to combine.",
          garnish
        ];
      }
      return [
        `Fill a ${glass} with ice.`,
        "Add the measured ingredients.",
        "Stir gently to combine.",
        garnish
      ];
    case "generic":
    default:
      if (isUpServedGlass(recipe.glassware)) {
        return [
          `Add the measured ingredients to a chilled ${glass}.`,
          "Stir gently until combined.",
          garnish
        ];
      }
      return [
        `Fill a ${glass} with ice.`,
        "Add the measured ingredients.",
        "Stir gently until chilled and combined.",
        garnish
      ];
  }
}

/**
 * Resolve the best instructions for a cocktail:
 *   1. full structured/numbered steps already in `method`
 *   2. prose instructions already in `method`
 *   3. otherwise, generated practical steps (with the short method label kept as metadata)
 */
export function resolveCocktailInstructions(recipe: CocktailRecipeForSteps): ResolvedCocktailInstructions {
  const parsed = parseCocktailInstructions(recipe.method);
  if (parsed.kind === "steps") {
    return { kind: "steps", steps: parsed.steps, methodLabel: null, generated: false };
  }
  if (parsed.kind === "prose") {
    return { kind: "prose", text: parsed.text };
  }
  const steps = buildCocktailSteps(recipe);
  const methodLabel = parsed.kind === "method" ? parsed.label : null;
  return { kind: "steps", steps, methodLabel, generated: true };
}
