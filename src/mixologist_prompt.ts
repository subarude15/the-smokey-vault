import {
  mixologistRequiredBottlePrompt,
  type ShelfBottle
} from "./cocktails.js";

export type MixologistPromptRecipe = {
  name: string;
  ingredients: string[];
  method: string;
  glassware: string;
  garnish: string;
  season: string;
  notes: string;
};

/** Same preamble the mixologist has always sent. Shelf is built per request by the caller. */
export function mixologistLlmPrompt(shelf: Array<{ name: string; kind: string }>, request: string): string {
  return `You are the house mixologist for The Smokey Vault. Prefer bottles actually on the shelf. Name the specific bottles when you can. Pantry staples (citrus, sugar, soda water, mint, egg white, espresso, ice) are assumed. Shelf: ${JSON.stringify(shelf)}. Request: ${request}. Return ONLY valid JSON with this exact shape: {"name":"string","ingredients":["exact measured ingredient"],"method":"string","glassware":"string","garnish":"string","season":"All|Spring|Summer|Fall|Winter|Holiday","notes":"brief tasting note and one substitution"}. Do not use markdown.`;
}

export function mixologistGenerateRequest(prompt: string | undefined, requiredBottle: ShelfBottle | null): string {
  return requiredBottle
    ? mixologistRequiredBottlePrompt(requiredBottle, prompt)
    : (prompt ?? "Create a cocktail");
}

/** Another drink for the same request. Not a rename, and not a second conversation. */
export function mixologistRetryRequest(
  prompt: string,
  previous: MixologistPromptRecipe,
  requiredBottle: ShelfBottle | null = null
): string {
  const original = mixologistGenerateRequest(prompt.trim() ? prompt : undefined, requiredBottle);
  const previousJson = JSON.stringify({
    name: previous.name,
    ingredients: previous.ingredients,
    method: previous.method,
    glassware: previous.glassware,
    garnish: previous.garnish,
    season: previous.season,
    notes: previous.notes
  });
  return `${original}

Previous suggestion:
${previousJson}

Generate another cocktail that satisfies the same original request.
The new cocktail must be materially different from the previous suggestion.
Do not merely rename the cocktail, change only the garnish, or change one minor measurement.
Prefer a different structure, flavor direction, technique, or base spirit when the user's request allows it.
Continue preferring bottles actually available on the shelf.
The new recipe must not have the same name and should not duplicate the same primary structure unless required by the user's constraints.`;
}
