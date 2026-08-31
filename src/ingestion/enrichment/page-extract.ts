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
  imageUrls: string[];
  usedJsonLd: boolean;
  usedOpenGraph: boolean;
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

  const ogImage = metaContent(html, "og:image");
  if (ogImage) {
    pushUnique(imageUrls, ogImage, pageUrl);
    usedOpenGraph = true;
  }
  const ogTitle = metaContent(html, "og:title");
  const ogDesc = metaContent(html, "og:description");
  if (ogTitle || ogDesc) usedOpenGraph = true;
  if (ogDesc) description = ogDesc.slice(0, 400);

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
    imageUrls: imageUrls.slice(0, 5),
    usedJsonLd,
    usedOpenGraph
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
