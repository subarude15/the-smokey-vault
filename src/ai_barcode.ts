import { normalizeAbv, normalizeUpc, parseVolumeMl } from "./cola_client.js";

/** What the model is asked to return for an unknown barcode. */
export type AiBarcodeProduct = {
  upc: string;
  name: string;
  brand: string;
  category: string;
  subcategory: string;
  abv: number;
  proof: number;
  volume_ml: number;
  description: string;
  image_url: string;
};

export function aiBarcodePrompt(upc: string) {
  return [
    `You are a beverage catalog researcher. Identify the bottle, can, or package sold under UPC/EAN ${upc}.`,
    "Reply with a single JSON object and nothing else. Use this exact shape:",
    '{"name":"","brand":"","category":"","subcategory":"","abv":0,"proof":0,"volume_ml":750,"description":"","image_url":""}',
    "Rules:",
    "- category must be one of: Whiskey, Vodka, Gin, Rum, Tequila, Brandy, Liqueur, Wine, Beer, Mixer, Other.",
    "- subcategory is the finer style, e.g. Bourbon, Islay Single Malt, IPA, Cabernet Sauvignon.",
    "- abv is percent alcohol by volume as a number. proof is twice the abv.",
    "- volume_ml is the container size in millilitres.",
    "- description is one short sentence a bartender would find useful.",
    "- image_url must be a direct https link to a public product photo, or an empty string.",
    "- If you are not confident this barcode belongs to a real product, return an empty name."
  ].join("\n");
}

function textField(source: Record<string, unknown>, key: string, limit: number) {
  return String(source[key] ?? "").trim().slice(0, limit);
}

function numberField(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** parseVolumeMl wants a unit string, so a bare number like 1750 is taken at face value. */
function volumeField(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  return parseVolumeMl(value) ?? 750;
}

/** Only https links survive, so a hallucinated data URI or local path never reaches the fetcher. */
function imageField(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the model's answer, tolerating markdown fences and surrounding chatter.
 * Returns null when there is no usable product, so the caller can fall through to a miss.
 */
export function parseAiBarcode(raw: string, upc: string): AiBarcodeProduct | null {
  const text = String(raw ?? "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!text) return null;

  let parsed: unknown = tryJson(text);
  if (parsed === undefined) {
    // Models often wrap the object in a sentence, so fall back to the outermost braces.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    parsed = tryJson(text.slice(start, end + 1));
  }
  // A one-product array is a common shape too; take the first object in it.
  if (Array.isArray(parsed)) parsed = parsed.find((entry) => entry && typeof entry === "object");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const name = textField(source, "name", 120);
  if (!name) return null;

  const abvFromField = normalizeAbv(source.abv) ?? 0;
  const proof = numberField(source.proof);
  // Either figure fills in for the other, since models often answer with only one.
  const abv = abvFromField || (proof ? Math.round((proof / 2) * 10) / 10 : 0);

  return {
    upc: normalizeUpc(upc),
    name,
    brand: textField(source, "brand", 90),
    category: textField(source, "category", 40) || "Other",
    subcategory: textField(source, "subcategory", 60),
    abv,
    proof: proof || Math.round(abv * 2 * 10) / 10,
    volume_ml: volumeField(source.volume_ml),
    description: textField(source, "description", 400),
    image_url: imageField(source.image_url)
  };
}
