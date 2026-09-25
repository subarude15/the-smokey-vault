import { type ProductSchema } from "../cola_client.js";
import { parseProductSchema } from "./normalize.js";
import { callLlm } from "../ai_client.js";

const PRODUCT_SCHEMA_PROMPT = `Return ONLY valid JSON matching this product schema:
{
  "upc": "digits only or empty string",
  "name": "product name or empty string",
  "brand": "brand, brewery, or producer or empty string",
  "category": "specific style/category such as Bourbon, IPA, Cabernet Sauvignon, Mixer",
  "abv": number or null,
  "image_url": null,
  "fill_level_percent": 100,
  "bottle_count": 1,
  "notes": "short useful lookup note or null",
  "volume_ml": milliliters as a number or null,
  "product_type": "spirit, wine, beer, mixer, or null",
  "ttb_id": null,
  "origin": "origin/region if known or null",
  "approval_date": null
}
Do not include markdown, prose, or keys outside the schema.`;

export async function lookupProductFromRawText(rawText: string): Promise<ProductSchema> {
  const text = rawText.trim();
  if (!text) throw new Error("Raw lookup text is required");
  const prompt = `Extract the best beverage product record from this raw web scrape text.\n\n${PRODUCT_SCHEMA_PROMPT}\n\nRaw text:\n${text.slice(0, 24_000)}`;
  const content = await callLlm(prompt);
  return parseProductSchema(content);
}
