import { type ProductSchema } from "../cola_client.js";
import { parseProductSchema } from "./normalize.js";
import { ollamaChatUrl, ollamaVisionModel } from "./enrichment/ollama-config.js";

const PRODUCT_JSON_FORMAT = {
  type: "object",
  properties: {
    upc: { type: "string" },
    name: { type: "string" },
    brand: { type: "string" },
    category: { type: "string" },
    abv: { type: ["number", "null"] },
    image_url: { type: ["string", "null"] },
    fill_level_percent: { type: "number" },
    bottle_count: { type: "number" },
    notes: { type: ["string", "null"] },
    volume_ml: { type: ["number", "null"] },
    product_type: { type: ["string", "null"] },
    ttb_id: { type: ["string", "null"] },
    origin: { type: ["string", "null"] },
    approval_date: { type: ["string", "null"] }
  },
  required: [
    "upc",
    "name",
    "brand",
    "category",
    "abv",
    "image_url",
    "fill_level_percent",
    "bottle_count",
    "notes",
    "volume_ml",
    "product_type",
    "ttb_id",
    "origin",
    "approval_date"
  ],
  additionalProperties: false
} as const;

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

const DEFAULT_LABEL_PROMPT =
  `Read this bottle, can, wine label, or product image and identify the beverage product. ${PRODUCT_SCHEMA_PROMPT}`;

type OllamaChatResponse = {
  message?: { content?: string };
  error?: unknown;
};

export type LocalOllamaLabelOptions = {
  /** Override the default product-schema prompt (scan pipeline may pass barcode context). */
  prompt?: string;
  /** Override OLLAMA_VISION_MODEL for this call only. */
  model?: string;
  timeoutMs?: number;
};

async function fetchLocalOllamaProduct(options: {
  model: string;
  prompt: string;
  imageBase64?: string;
  timeoutMs?: number;
}): Promise<ProductSchema> {
  const response = await fetch(ollamaChatUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    body: JSON.stringify({
      model: options.model,
      stream: false,
      keep_alive: -1,
      format: PRODUCT_JSON_FORMAT,
      messages: [
        {
          role: "user",
          content: options.prompt,
          ...(options.imageBase64 ? { images: [options.imageBase64] } : {})
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({})) as OllamaChatResponse;
  if (!response.ok) {
    const message = typeof data.error === "string"
      ? data.error
      : data.error && typeof data.error === "object" && "message" in data.error
        ? String((data.error as { message: unknown }).message)
        : `Ollama returned ${response.status}`;
    throw new Error(message);
  }
  return parseProductSchema(data.message?.content ?? "");
}

/**
 * Dedicated vision-model label read (OLLAMA_VISION_MODEL; deploy with qwen2.5vl:7b).
 * Does not use AI_MODEL / Gemma — that path is callLlm for general generation.
 */
export async function labelProductWithLocalOllama(
  imageBase64: string,
  options: LocalOllamaLabelOptions = {}
): Promise<ProductSchema> {
  const image = imageBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
  if (!image) throw new Error("Image required");
  return fetchLocalOllamaProduct({
    model: options.model || ollamaVisionModel(),
    imageBase64: image,
    prompt: options.prompt?.trim() || DEFAULT_LABEL_PROMPT,
    timeoutMs: options.timeoutMs
  });
}

export async function lookupProductFromRawText(rawText: string): Promise<ProductSchema> {
  const text = rawText.trim();
  if (!text) throw new Error("Raw lookup text is required");
  return fetchLocalOllamaProduct({
    model: "llama3.1",
    prompt: `Extract the best beverage product record from this raw web scrape text.\n\n${PRODUCT_SCHEMA_PROMPT}\n\nRaw text:\n${text.slice(0, 24_000)}`
  });
}
