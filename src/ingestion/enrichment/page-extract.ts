/**
 * Bounded structured extraction from authoritative product HTML.
 * Never persists full HTML — returns short fact/snippet text + image URLs.
 */
export type StructuredProductFacts = {
  /** Compact text suitable for LLM / diagnostic snippets. */
  textSnippet: string;
  abv: number | null;
  categoryHint: string | null;
  originHint: string | null;
  description: string | null;
  /** Product name from JSON-LD / OG when present. */
  productName: string | null;
  imageUrls: string[];
  usedJsonLd: boolean;
  usedOpenGraph: boolean;
  /** True when og:type is product (or similar). */
  ogTypeProduct: boolean;
  /** True when JSON-LD @type includes Product. */
  hasJsonLdProduct: boolean;
  /** GTIN / gtin13 / sku / productID raw values found (bounded). */
  gtinHints: string[];
  /** Price / offers / volume variant signals present. */
  hasPriceOrVariant: boolean;
};

function pushUnique(out: string[], raw: string, baseUrl: string) {
  const value = String(raw ?? "").trim();
  if (!value) return;
  try {
    const abs = new URL(value, baseUrl).toString();
    if (/^https?:\/\//i.test(abs) && !out.includes(abs)) out.push(abs);
  } catch {
    /* ignore */
  }
}

function metaContent(html: string, property: string): string | null {
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["'][^>]*>`,
    "i"
  );
  return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? null;
}

function parseAbv(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 0 && raw <= 100 ? raw : null;
  }
  const text = String(raw);
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (match) {
    const n = Number(match[1]);
    return n > 0 && n <= 100 ? n : null;
  }
  const bare = Number(text);
  return Number.isFinite(bare) && bare > 0 && bare <= 100 ? bare : null;
}

/**
 * Extract Product JSON-LD + Open Graph facts from a page.
 * Bounded — ignores large bodies beyond caller-supplied HTML slice.
 */
export function extractStructuredProductFacts(
  html: string,
  pageUrl: string
): StructuredProductFacts {
  const imageUrls: string[] = [];
  let abv: number | null = null;
  let categoryHint: string | null = null;
  let originHint: string | null = null;
  let description: string | null = null;
  let name: string | null = null;
  let usedJsonLd = false;
  let usedOpenGraph = false;
  let ogTypeProduct = false;
  let hasJsonLdProduct = false;
  const gtinHints: string[] = [];
  let hasPriceOrVariant = false;

  const ogImage = metaContent(html, "og:image");
  if (ogImage) {
    pushUnique(imageUrls, ogImage, pageUrl);
    usedOpenGraph = true;
  }
  const ogTitle = metaContent(html, "og:title");
  const ogDesc = metaContent(html, "og:description");
  const ogType = metaContent(html, "og:type");
  if (ogTitle || ogDesc || ogType) usedOpenGraph = true;
  if (ogDesc) description = ogDesc.slice(0, 400);
  if (ogType && /product/i.test(ogType)) ogTypeProduct = true;
  if (ogTitle && !name) name = ogTitle.slice(0, 160);

  const jsonLdBlocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of jsonLdBlocks) {
    const raw = block[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const record = node as Record<string, unknown>;
        const type = String(record["@type"] ?? "");
        const isProduct = /product/i.test(type);
        if (isProduct) hasJsonLdProduct = true;
        if (!isProduct && !record.image && !record.alcoholByVolume && !record.description) {
          continue;
        }
        usedJsonLd = true;
        if (typeof record.name === "string") name = record.name.slice(0, 160);
        if (typeof record.description === "string" && !description) {
          description = record.description.slice(0, 400);
        }
        const cat = record.category ?? record.additionalType;
        if (typeof cat === "string") categoryHint = cat.slice(0, 80);
        const abvRaw =
          record.alcoholByVolume
          ?? record.abv
          ?? (record.additionalProperty as unknown);
        if (abv == null) abv = parseAbv(abvRaw);
        for (const key of ["gtin", "gtin13", "gtin14", "gtin8", "sku", "productID", "mpn"] as const) {
          const v = record[key];
          if (v != null && gtinHints.length < 4) {
            const s = String(v).trim();
            if (s && !gtinHints.includes(s)) gtinHints.push(s.slice(0, 32));
          }
        }
        if (record.offers != null || record.price != null) hasPriceOrVariant = true;
        if (Array.isArray(record.additionalProperty)) {
          for (const prop of record.additionalProperty) {
            if (!prop || typeof prop !== "object") continue;
            const p = prop as { name?: unknown; value?: unknown };
            const propName = String(p.name ?? "").toLowerCase();
            if (/abv|alcohol/.test(propName) && abv == null) abv = parseAbv(p.value);
            if (/origin|region|country/.test(propName) && !originHint) {
              originHint = String(p.value ?? "").slice(0, 80) || null;
            }
            if (/type|category|class/.test(propName) && !categoryHint) {
              categoryHint = String(p.value ?? "").slice(0, 80) || null;
            }
            if (/volume|size|variant/.test(propName)) hasPriceOrVariant = true;
          }
        }
        const image = record.image;
        if (typeof image === "string") pushUnique(imageUrls, image, pageUrl);
        else if (Array.isArray(image)) {
          for (const item of image) {
            if (typeof item === "string") pushUnique(imageUrls, item, pageUrl);
            else if (item && typeof item === "object" && "url" in item) {
              pushUnique(imageUrls, String((item as { url?: unknown }).url ?? ""), pageUrl);
            }
          }
        } else if (image && typeof image === "object" && "url" in (image as object)) {
          pushUnique(imageUrls, String((image as { url?: unknown }).url ?? ""), pageUrl);
        }
      }
    } catch {
      /* ignore malformed json-ld */
    }
  }

  // Light ABV / classification hints from og description when JSON-LD lacked them.
  if (abv == null && description) abv = parseAbv(description);
  if (!categoryHint && description) {
    const classMatch = description.match(
      /\b(single malt scotch(?:\s+whisky)?|scotch whisky|irish whiskey|bourbon|rye whiskey|tennessee whiskey)\b/i
    );
    if (classMatch) categoryHint = classMatch[1];
  }
  if (!originHint && description) {
    const originMatch = description.match(/\b(Scotland|Ireland|Kentucky|Tennessee|Japan|Canada)\b/i);
    if (originMatch) originHint = originMatch[1];
  }
  if (/\b(?:750\s*mL|1\.75\s*L|price|buy now|add to cart)\b/i.test(html.slice(0, 40_000))) {
    hasPriceOrVariant = true;
  }

  const parts = [
    name ? `Name: ${name}` : null,
    categoryHint ? `Category: ${categoryHint}` : null,
    abv != null ? `ABV: ${abv}%` : null,
    originHint ? `Origin: ${originHint}` : null,
    description ? `Description: ${description}` : null,
    ogTitle && ogTitle !== name ? `OG title: ${ogTitle}` : null
  ].filter(Boolean);

  return {
    textSnippet: parts.join("\n").slice(0, 1200),
    abv,
    categoryHint,
    originHint,
    description,
    productName: name,
    imageUrls: imageUrls.slice(0, 5),
    usedJsonLd,
    usedOpenGraph,
    ogTypeProduct,
    hasJsonLdProduct,
    gtinHints: gtinHints.slice(0, 4),
    hasPriceOrVariant
  };
}

/** Default bounded HTML fetch for authoritative pages. */
export async function fetchBoundedPageHtml(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000
): Promise<string | null> {
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/html" }
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.slice(0, 200_000);
  } catch {
    return null;
  }
}
