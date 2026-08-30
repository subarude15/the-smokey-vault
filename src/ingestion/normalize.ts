import {
  normalizeAbv,
  normalizeUpc,
  parseVolumeMl,
  type ProductSchema
} from "../cola_client.js";

function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = String(raw ?? "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Ollama did not return JSON product data");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrDefault(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize Ollama / catalog JSON into the shared ProductSchema. */
export function parseProductSchema(raw: string | Record<string, unknown>): ProductSchema {
  const value = typeof raw === "string" ? parseJsonObject(raw) : raw;
  return {
    upc: normalizeUpc(String(value.upc ?? value.code ?? value.barcode ?? "")),
    name: String(value.name ?? value.product_name ?? "").trim(),
    brand: String(value.brand ?? value.brands ?? value.brewery ?? value.producer ?? "").trim(),
    category: String(value.category ?? value.categories ?? "").trim() || "Spirits",
    abv: normalizeAbv(value.abv),
    image_url: nullableString(value.image_url),
    fill_level_percent: numberOrDefault(value.fill_level_percent, 100),
    bottle_count: numberOrDefault(value.bottle_count, 1),
    notes: nullableString(value.notes),
    volume_ml: typeof value.volume_ml === "number" ? value.volume_ml : parseVolumeMl(value.volume_ml ?? value.volume ?? value.net_contents),
    product_type: nullableString(value.product_type),
    ttb_id: nullableString(value.ttb_id),
    origin: nullableString(value.origin),
    approval_date: nullableString(value.approval_date)
  };
}

/** Inventory form fields → ProductSchema for smart-fallback callers. */
export function inventoryRecordToProduct(product: Record<string, unknown>, upcHint = ""): ProductSchema {
  return parseProductSchema({
    ...product,
    upc: product.upc || upcHint,
    fill_level_percent: product.fill_level_percent ?? product.fill_level ?? 100,
    bottle_count: product.bottle_count ?? product.stock_count ?? 1
  });
}

export function smartWebQuery(query: { upc?: string; name?: string }) {
  const parts = [query.name?.trim(), query.upc?.trim()].filter(Boolean);
  if (!parts.length) return "";
  return `${parts.join(" ")} beer abv style description`;
}
