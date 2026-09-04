/**
 * Local vision model as product-image verifier (structured JSON only).
 * Does not rewrite identity — identity is supplied as immutable context.
 */
import { normalizeCanonicalTaxonomy } from "../../canonical-normalize.js";
import type { BottleCandidate } from "../candidate/types.js";
import type { VisionVerification } from "./image-score.js";
import { ollamaChatUrl, ollamaVisionModel } from "./ollama-config.js";

export type ImageVerifyRequest = {
  candidate: BottleCandidate;
  imageUrl: string;
  /** Optional base64 (no data: prefix) when already downloaded for verification. */
  imageBase64?: string | null;
};

type OllamaChatResponse = {
  message?: { content?: string };
  error?: unknown;
};

const VERIFY_FORMAT = {
  type: "object",
  properties: {
    correct_product: { type: "boolean" },
    bottle_prominent: { type: "boolean" },
    contains_people: { type: "boolean" },
    meme_or_graphic: { type: "boolean" },
    clean_product_photo: { type: "boolean" },
    multiple_products: { type: "boolean" }
  },
  required: [
    "correct_product",
    "bottle_prominent",
    "contains_people",
    "meme_or_graphic",
    "clean_product_photo",
    "multiple_products"
  ],
  additionalProperties: false
};

/**
 * Trusted identity for vision — includes family/subtype when known.
 * Search aliases must not mutate these canonical fields.
 */
export function identityContextForVision(candidate: BottleCandidate) {
  const categoryRaw = String(candidate.category.value ?? "").trim();
  const tax = normalizeCanonicalTaxonomy(categoryRaw, "");
  const family = tax.family || null;
  const subCategory = tax.type || (tax.family && categoryRaw && categoryRaw !== tax.family ? categoryRaw : "") || null;
  return {
    upc: candidate.upc.value,
    name: candidate.name.value,
    brand: candidate.brand.value,
    product_type: candidate.product_type.value,
    family,
    category: subCategory || family || categoryRaw || null,
    sub_category: subCategory
  };
}

export function buildImageVerifyPrompt(request: ImageVerifyRequest): string {
  return `You verify whether an image is a clean product photo of ONE specific bottle.

Trusted identity (immutable — do NOT invent or change these fields):
${JSON.stringify(identityContextForVision(request.candidate), null, 2)}

Image URL (for reference): ${request.imageUrl}

Answer ONLY with JSON booleans:
- correct_product: true ONLY if the image shows THIS exact product (same brand AND expression/name), not merely the same brand or a sibling expression
- bottle_prominent: true if a bottle/can is the main subject
- contains_people: true if people are visible/prominent
- meme_or_graphic: true if meme, text collage, banner, or heavy graphic overlay
- clean_product_photo: true if a clear product packshot / bottle photo
- multiple_products: true if many unrelated bottles dominate the frame

Do not return product name, brand, UPC, or any other keys.`;
}

export function parseVisionVerification(raw: string | Record<string, unknown> | null): VisionVerification | null {
  let parsed: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") parsed = raw;
  else if (typeof raw === "string") {
    const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!parsed) return null;
  const bool = (key: string) => Boolean(parsed![key]);
  return {
    correct_product: bool("correct_product"),
    bottle_prominent: bool("bottle_prominent"),
    contains_people: bool("contains_people"),
    meme_or_graphic: bool("meme_or_graphic"),
    clean_product_photo: bool("clean_product_photo"),
    multiple_products: bool("multiple_products")
  };
}

async function fetchImageBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.startsWith("image/") && !type.includes("octet-stream")) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length < 32) return null;
    return buf.toString("base64");
  } catch {
    return null;
  }
}

/** Local Ollama vision verifier (endpoint + model from shared ollama-config). */
export async function verifyProductImage(request: ImageVerifyRequest): Promise<VisionVerification | null> {
  const image =
    request.imageBase64?.trim() ||
    (await fetchImageBase64(request.imageUrl));
  if (!image) {
    throw new Error("fetch_failed");
  }

  const chatUrl = ollamaChatUrl();
  const model = ollamaVisionModel();

  let response: Response;
  try {
    response = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: -1,
        format: VERIFY_FORMAT,
        messages: [
          {
            role: "user",
            content: buildImageVerifyPrompt(request),
            images: [image]
          }
        ]
      })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "vision provider unreachable";
    throw new Error(`vision_provider_error: ${message}`);
  }

  const data = await response.json().catch(() => ({})) as OllamaChatResponse;
  if (!response.ok) {
    const message = typeof data.error === "string"
      ? data.error
      : `Ollama returned ${response.status}`;
    throw new Error(`vision_provider_error: ${message}`);
  }
  const parsed = parseVisionVerification(data.message?.content ?? null);
  if (!parsed) {
    throw new Error("vision_parse_failed");
  }
  return parsed;
}
