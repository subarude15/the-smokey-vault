import { normalizeAbv, normalizeUpc, parseVolumeMl } from "./cola_client.js";

export type VisionLabel = {
  name: string;
  brand: string;
  category: string;
  abv: number | null;
  volume_ml: number | null;
  upc: string;
  product_type: string;
};

const PRODUCT_TYPES = new Set(["spirit", "wine", "beer", "mixer"]);

export const VISION_LABEL_PROMPT = `Read this bottle, can, or wine label. Return ONLY JSON with keys name, brand, category, abv, volume_ml, upc, product_type.
product_type must be one of: spirit, wine, beer, mixer.
abv is a number or null. volume_ml is milliliters or null.
upc is digits only if a barcode number is printed on the label, else "".
If a field is unreadable use "" or null. No markdown.`;

export function parseVisionLabel(raw: string): VisionLabel {
  const cleaned = String(raw ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Could not read that label. Try again, a little closer.");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("Could not read that label. Try again, a little closer.");
  }
  const productType = String(value.product_type ?? value.productType ?? "").trim().toLowerCase();
  const upc = normalizeUpc(String(value.upc ?? value.code ?? value.barcode ?? ""));
  const volume = typeof value.volume_ml === "number" ? value.volume_ml : parseVolumeMl(value.volume_ml ?? value.volume ?? value.net_contents);
  const name = String(value.name ?? value.product_name ?? "").trim();
  const brand = String(value.brand ?? value.brands ?? value.producer ?? value.brewery ?? "").trim();
  let category = String(value.category ?? value.categories ?? "").trim();
  if (!category) {
    if (productType === "beer") category = "Beer";
    else if (productType === "wine") category = "Wine";
    else if (productType === "mixer") category = "Mixer";
  }
  return {
    name,
    brand,
    category,
    abv: normalizeAbv(value.abv),
    volume_ml: volume != null && Number.isFinite(volume) ? Math.round(volume) : null,
    upc,
    product_type: PRODUCT_TYPES.has(productType) ? productType : ""
  };
}
