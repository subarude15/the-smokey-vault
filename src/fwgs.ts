import { parseVolumeMl, type ProductSchema } from "./cola_client.js";

export const FWGS_SEARCH_URL = "https://www.finewineandgoodspirits.com/search";
export const FWGS_TIMEOUT_MS = 12_000;
export const FWGS_DELAY_MS = Number(process.env.FWGS_DELAY_MS ?? 400);

const BROWSER_UA = "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

export type FwgsProduct = {
  name: string;
  brand: string;
  volume_ml: number | null;
  price: string;
  image_url: string | null;
};

let lastFwgsAt = 0;

export function resetFwgsDelay() {
  lastFwgsAt = 0;
}

async function politePause() {
  const wait = FWGS_DELAY_MS - (Date.now() - lastFwgsAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripTags(value: string) {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function absUrl(raw: string) {
  const href = decodeEntities(raw.trim()).replace(/^\/\//, "https://");
  if (!href) return "";
  try {
    return new URL(href, FWGS_SEARCH_URL).href;
  } catch {
    return "";
  }
}

function firstImageUrl(value: unknown): string {
  if (typeof value === "string") return absUrl(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstImageUrl(entry);
      if (found) return found;
    }
  }
  if (value && typeof value === "object" && "url" in value) {
    return firstImageUrl((value as { url?: unknown }).url);
  }
  return "";
}

function readPrice(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return `$${value.toFixed(2)}`;
  const text = String(value);
  const match = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return "";
  return `$${Number.parseFloat(match[1]!).toFixed(2)}`;
}

function readVolume(...values: unknown[]): number | null {
  for (const value of values) {
    if (value == null || value === "") continue;
    const parsed = typeof value === "number" ? value : parseVolumeMl(value) ?? parseVolumeMl(String(value).replace(/(\d+(?:\.\d+)?)\s*(ml|l)\b/i, "$1 $2"));
    if (parsed) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function jsonLdNodes(raw: unknown, into: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    for (const entry of raw) jsonLdNodes(entry, into);
    return into;
  }
  const record = asRecord(raw);
  if (!record) return into;
  into.push(record);
  if (record["@graph"]) jsonLdNodes(record["@graph"], into);
  if (record.itemListElement) jsonLdNodes(record.itemListElement, into);
  if (record.item) jsonLdNodes(record.item, into);
  return into;
}

function usableFwgsName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (/product request|request form|sign in|create account|access denied|akamai|pardon our|search results|^search$/i.test(trimmed)) {
    return false;
  }
  if (/fine wine/i.test(trimmed) && /good spirits/i.test(trimmed)) return false;
  return true;
}

function productFromJsonLd(node: Record<string, unknown>): FwgsProduct | null {
  const type = String(node["@type"] ?? node.type ?? "");
  if (!/product/i.test(type) && !node.offers && !node.image) return null;
  const name = String(node.name ?? node.product_name ?? "").trim();
  if (!usableFwgsName(name)) return null;
  const offers = asRecord(node.offers) ?? (Array.isArray(node.offers) ? asRecord(node.offers[0]) : null);
  const brandNode = asRecord(node.brand);
  const brand = String(brandNode?.name ?? node.brand ?? "").trim();
  return {
    name,
    brand,
    volume_ml: readVolume(node.size, node.volume, node.netContent, name),
    price: readPrice(offers?.price ?? offers?.lowPrice ?? node.price),
    image_url: firstImageUrl(node.image) || null
  };
}

function metaContent(html: string, property: string) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return decodeEntities((match?.[1] || match?.[2] || "").trim());
}

function pickCardHtml(html: string): string[] {
  const cards: string[] = [];
  const opener = /<(?:div|article|li)[^>]*(?:product-tile|product-card|product-item|productTile|c-product|search-result)[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html))) {
    cards.push(html.slice(match.index, match.index + 5000));
    if (cards.length >= 6) break;
  }
  return cards;
}

function productFromCard(card: string): FwgsProduct | null {
  const nameMatch = card.match(/<(?:a|h[1-3]|span|p)[^>]*(?:product-name|pdp-link|tile-name|name)[^>]*>([\s\S]*?)<\/(?:a|h[1-3]|span|p)>/i)
    || card.match(/<a[^>]+class=["'][^"']*(?:name|link)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  const name = stripTags(nameMatch?.[1] ?? "");
  if (!usableFwgsName(name)) return null;
  const img = card.match(/<(?:img|source)[^>]+(?:src|data-src|srcset)=["']([^"'\s]+)/i);
  const size = card.match(/<(?:span|div|p)[^>]*(?:size|volume|pack-size)[^>]*>([\s\S]*?)<\/(?:span|div|p)>/i);
  const price = card.match(/\$\s*\d+(?:\.\d{1,2})?/)?.[0] ?? "";
  const brand = stripTags((card.match(/<(?:span|div)[^>]*(?:brand|producer)[^>]*>([\s\S]*?)<\/(?:span|div)>/i)?.[1] ?? ""));
  return {
    name,
    brand,
    volume_ml: readVolume(stripTags(size?.[1] ?? ""), name),
    price: readPrice(price),
    image_url: img ? absUrl(img[1] ?? "") || null : null
  };
}

function emptySearch(html: string) {
  return /no results|0 results|did not match|nothing matched|couldn['’]t find|product request form/i.test(html);
}

/**
 * Reads a Fine Wine & Good Spirits search page. HTML can change; this walks
 * JSON-LD, product tiles, then Open Graph and never throws on unfamiliar markup.
 */
export function parseFwgsHtml(html: string): FwgsProduct | null {
  const text = String(html ?? "");
  if (!text.trim() || emptySearch(text)) return null;

  const jsonBlocks = [...text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of jsonBlocks) {
    try {
      const parsed: unknown = JSON.parse(block[1] ?? "");
      for (const node of jsonLdNodes(parsed)) {
        const product = productFromJsonLd(node);
        if (product) return product;
      }
    } catch {
      // Markup drift; try the next block.
    }
  }

  for (const card of pickCardHtml(text)) {
    const product = productFromCard(card);
    if (product) return product;
  }

  const ogTitle = metaContent(text, "og:title") || metaContent(text, "twitter:title");
  if (ogTitle && usableFwgsName(ogTitle) && !/search/i.test(ogTitle)) {
    return {
      name: ogTitle.replace(/\s*[|\-–].*$/, "").trim(),
      brand: "",
      volume_ml: readVolume(ogTitle),
      price: readPrice(metaContent(text, "product:price:amount") || metaContent(text, "og:price:amount")),
      image_url: absUrl(metaContent(text, "og:image") || metaContent(text, "twitter:image")) || null
    };
  }
  return null;
}

export function fwgsToSchema(upc: string, hit: FwgsProduct): ProductSchema {
  const notes = [hit.price ? `FWGS ${hit.price}` : "", hit.volume_ml ? `${hit.volume_ml} ml` : ""].filter(Boolean).join(" | ") || null;
  return {
    upc,
    name: hit.name,
    brand: hit.brand,
    category: "Spirits",
    abv: null,
    image_url: hit.image_url,
    fill_level_percent: 100,
    bottle_count: 1,
    notes,
    volume_ml: hit.volume_ml,
    product_type: null,
    ttb_id: null,
    origin: null,
    approval_date: null
  };
}

export function isFwgsThin(hit: FwgsProduct | null): boolean {
  if (!hit?.name.trim()) return true;
  return hit.volume_ml == null;
}

export async function searchFwgs(upc: string): Promise<FwgsProduct | null> {
  const code = String(upc ?? "").replace(/\D/g, "");
  if (!code) return null;
  await politePause();
  lastFwgsAt = Date.now();
  try {
    const url = `${FWGS_SEARCH_URL}?Ntt=${encodeURIComponent(code)}`;
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": BROWSER_UA
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FWGS_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const html = await response.text();
    return parseFwgsHtml(html);
  } catch {
    return null;
  }
}
