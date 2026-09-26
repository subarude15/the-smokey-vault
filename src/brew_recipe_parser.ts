import { brewRecipeDocumentSchema, type BrewRecipeDocument } from "./brew_sheets.js";

/** Matches brew recipe sourceText. Longer pastes are rejected before any AI call. */
export const BREW_RECIPE_PARSE_MAX_CHARS = 100_000;

/**
 * Output budget for one structured brew sheet.
 * The shared caller defaults to a short completion; a full grist, hop, and process
 * document does not fit in that budget.
 */
export const BREW_RECIPE_PARSE_MAX_TOKENS = 8192;

export type BrewRecipeParseFailure = "empty" | "too_long" | "malformed" | "invalid";

export type BrewRecipeAiCaller = (prompt: string) => Promise<string>;

const PARSE_FAILURE_MESSAGE = "The AI could not parse this brewing recipe";

export class BrewRecipeParseError extends Error {
  readonly code: BrewRecipeParseFailure;

  constructor(code: BrewRecipeParseFailure) {
    super(messageForParseFailure(code));
    this.name = "BrewRecipeParseError";
    this.code = code;
  }
}

function messageForParseFailure(code: BrewRecipeParseFailure): string {
  switch (code) {
    case "empty":
      return "Brewing instructions are required";
    case "too_long":
      return "Brewing instructions are too long";
    case "malformed":
    case "invalid":
      return PARSE_FAILURE_MESSAGE;
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

/** HTTP status for a parser failure. Upstream provider faults stay 502 at the route. */
export function brewRecipeParseStatus(error: BrewRecipeParseError): 400 | 502 {
  switch (error.code) {
    case "empty":
    case "too_long":
      return 400;
    case "malformed":
    case "invalid":
      return 502;
    default: {
      const unreachable: never = error.code;
      return unreachable;
    }
  }
}

const BREW_RECIPE_PARSE_INSTRUCTIONS = `You are a brewing recipe data extractor for Smokey Barrel Brewery.

Convert the supplied brewing instructions into one JSON object with exactly the keys listed below.

Do not redesign, summarize, or improve the recipe.
Do not invent missing brewing values.
Do not calculate values that are not explicitly supplied. A clearly stated approximation may be normalized ("about 25 IBU" may become "25"). Keep ranges, units, temperatures, and gravity values as written.
Do not invent salt weights from ppm targets.
Salt gram amounts are calculated later by a deterministic water-chemistry module. Never output salt addition masses.
Preserve ingredient names exactly, including proprietary names.
Preserve quantities, timings (Day 2, Day 3, 10 min, 20 min), gravity triggers, and temperatures.
Keep boil additions, whirlpool additions, dry-hop stages, fermentation steps, and packaging steps in their own fields.
Include system and fermenter information when the text provides them.
Include water chemistry targets when the text provides them.
Include checklist steps only when the text clearly states them.
Retain important warnings, including whirlfloc or Irish moss prohibitions, oxygen-free transfer, whirlpool temperature, and ALDC timing.

Return only a JSON object. No Markdown, no HTML, and no commentary.

Top-level keys, all required in the object (use "" , [] , or {} when the text does not supply them):
- beerName: string, the beer name exactly as written
- style: string
- system: string, brew system
- fermenter: string
- targetPackaged: string, packaged or yield volume
- fermenterVolume: string
- boilTime: string
- targetOg: string
- targetFg: string
- targetAbv: string
- estimatedIbu: string
- mashEfficiency: string
- water: object. Use only keys you can support from the text, such as source, strikeWater, spargeWater, totalWater, targetMashPh, chloridePpm, sulfatePpm, calciumPpm, sodiumPpm, magnesiumPpm, notes. Keep ppm targets and volumes as written ranges or values. Do not invent salt weights.
- fermentables: array of objects with ingredient and amount. Include lovibond or color only when the text states them.
- kettleAdditions: array of objects for boil additions, with ingredient, amount, and time
- whirlpoolAdditions: array of objects with ingredient, amount, temperature, and time
- dryHopStages: array of objects with stage, variety, amount, when, temperature, and gravity when stated
- fermentation: object. Include yeast and steps (when, temperature, gravity, action) when stated
- packaging: object. Include steps when stated
- warnings: array of strings
- checklist: array of strings
- notes: string

Scalar fields are strings, not numbers. Nested objects may omit keys the text does not support.`;

function brewRecipeParsePrompt(rawText: string): string {
  return `${BREW_RECIPE_PARSE_INSTRUCTIONS}

BREWING INSTRUCTIONS
${rawText}`;
}

/** One wrapping ``` or ```json fence. Anything else is parsed as-is. */
function stripSingleJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function brewRecipeFromAiText(raw: string): BrewRecipeDocument {
  const payload = stripSingleJsonFence(raw);
  if (!payload) throw new BrewRecipeParseError("malformed");
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new BrewRecipeParseError("malformed");
  }
  const parsed = brewRecipeDocumentSchema.safeParse(value);
  if (!parsed.success) throw new BrewRecipeParseError("invalid");
  return parsed.data;
}

/**
 * Turns pasted brewing instructions into a validated BrewRecipeDocument.
 * `complete` is the app's existing AI caller (configured provider, then failover).
 * This function does not write a recipe or a brew session.
 */
export async function parseBrewRecipeFromText(
  rawText: string,
  complete: BrewRecipeAiCaller
): Promise<BrewRecipeDocument> {
  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new BrewRecipeParseError("empty");
  }
  if (rawText.length > BREW_RECIPE_PARSE_MAX_CHARS) {
    throw new BrewRecipeParseError("too_long");
  }
  const raw = await complete(brewRecipeParsePrompt(rawText));
  return brewRecipeFromAiText(typeof raw === "string" ? raw : "");
}
