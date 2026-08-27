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
  return {
    name: value.name,
    ingredients: value.ingredients,
    method: value.method,
    glassware: value.glassware || "Rocks",
    garnish: value.garnish || "None",
    season: ["Spring","Summer","Fall","Winter","Holiday"].includes(value.season ?? "") ? value.season! : "All",
    notes: value.notes || "",
    image_url: typeof value.image_url === "string" ? value.image_url : "",
    source_url: typeof value.source_url === "string" ? value.source_url : ""
  };
}
