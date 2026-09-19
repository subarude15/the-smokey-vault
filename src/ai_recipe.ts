export type GeneratedRecipe = {
  name: string;
  ingredients: string[];
  method: string;
  glassware: string;
  garnish: string;
  season: string;
  notes: string;
  image_url?: string;
  source_url?: string;
  bartender_fav?: boolean | number;
};

export class AiRecipeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRecipeParseError";
  }
}

export function parseGeneratedRecipe(result: string): GeneratedRecipe {
  const cleaned = result.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiRecipeParseError("The AI returned an incomplete recipe. Please try again.");
  let value: Partial<GeneratedRecipe>;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1)) as Partial<GeneratedRecipe>;
  } catch {
    throw new AiRecipeParseError("The AI returned a recipe in an unexpected format. Please try again.");
  }
  if (!value.name || !Array.isArray(value.ingredients) || !value.ingredients.every((ingredient) => typeof ingredient === "string") || !value.method) {
    throw new AiRecipeParseError("The AI recipe was missing required details. Please try again.");
  }
  return normalizeGeneratedRecipe(value);
}

const GENERATED_SAVE_KEYS = new Set(["name", "ingredients", "method", "glassware", "garnish", "season", "notes"]);

/**
 * Body contract for saving an already-generated recipe.
 * Rejects Keeper-only and persistence fields instead of ignoring them.
 */
export function parseGeneratedRecipeSave(body: unknown): GeneratedRecipe {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AiRecipeParseError("A name, ingredients, and method are required.");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!GENERATED_SAVE_KEYS.has(key)) {
      throw new AiRecipeParseError("That field cannot be set when saving a generated recipe.");
    }
  }
  return normalizeGeneratedRecipe(record, { requireIngredients: true });
}

function normalizeGeneratedRecipe(
  value: Partial<GeneratedRecipe>,
  options: { requireIngredients?: boolean } = {}
): GeneratedRecipe {
  if (!value.name || typeof value.name !== "string" || !value.name.trim()
    || !Array.isArray(value.ingredients)
    || !value.ingredients.every((ingredient) => typeof ingredient === "string")
    || (options.requireIngredients && value.ingredients.length === 0)
    || !value.method || typeof value.method !== "string" || !value.method.trim()) {
    throw new AiRecipeParseError(
      options.requireIngredients
        ? "A name, ingredients, and method are required."
        : "The AI recipe was missing required details. Please try again."
    );
  }
  return {
    name: value.name.trim(),
    ingredients: value.ingredients,
    method: value.method.trim(),
    glassware: typeof value.glassware === "string" && value.glassware.trim() ? value.glassware.trim() : "Rocks",
    garnish: typeof value.garnish === "string" && value.garnish.trim() ? value.garnish.trim() : "None",
    season: ["Spring","Summer","Fall","Winter","Holiday"].includes(value.season ?? "") ? value.season! : "All",
    notes: typeof value.notes === "string" ? value.notes : "",
    image_url: typeof value.image_url === "string" ? value.image_url : "",
    source_url: typeof value.source_url === "string" ? value.source_url : ""
  };
}
