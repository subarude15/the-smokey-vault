/**
 * PR129 — Conservative cocktail recipe imagery.
 *
 * Fill-missing only: never overwrite an existing cocktail image_url.
 * Prefer imagery from an imported recipe's own source page; otherwise search
 * for an exact-named cocktail recipe page and extract Recipe JSON-LD / OG image.
 * Always localize through existing image safety helpers before saving.
 */
import { db } from "./db.js";
import { isLocalImagePath, localizeImage, type LocalizeImageDeps } from "./images.js";
import { searchWebHits, type WebSearchHit } from "./ingestion/web-search.js";
import {
  fetchPublicHtml,
  metaContent,
  type ImportedRecipe
} from "./recipe_import.js";

export type CocktailImageDiscoveryResult =
  | { status: "updated"; image_url: string; source_url?: string }
  | { status: "no_result"; reason?: string }
  | { status: "already_has_image"; image_url: string };

export type CocktailImageRow = {
  id: number;
  name: string;
  image_url?: string | null;
  source_url?: string | null;
  ingredients?: string | null;
  notes?: string | null;
  collection?: string | null;
};

export type CocktailImageDiscoveryDeps = {
  searchWebHits?: (query: string, limit?: number) => Promise<WebSearchHit[]>;
  fetchHtml?: (url: string) => Promise<{ html: string; finalUrl: string }>;
  localizeImage?: (url: string | null | undefined, deps?: LocalizeImageDeps) => Promise<string | null>;
  localizeImageDeps?: LocalizeImageDeps;
  maxCandidates?: number;
};

/** Hosts that must never supply cocktail recipe imagery. */
const REJECTED_HOST_FRAGMENTS = [
  "pinterest.",
  "pinimg.",
  "shutterstock.",
  "gettyimages.",
  "istockphoto.",
  "unsplash.",
  "pexels.",
  "adobe.com",
  "stock.adobe",
  "dreamstime.",
  "alamy.",
  "depositphotos.",
  "facebook.com",
  "fbcdn.",
  "instagram.com",
  "cdninstagram.",
  "twitter.com",
  "x.com",
  "t.co",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "redd.it",
  "tumblr.com",
  "flickr.com",
  "amazon.",
  "ebay.",
  "etsy.",
  "walmart.",
  "target.com",
  "wikipedia.org",
  "wikimedia.org",
  "blogspot.",
  "wordpress.com",
  "medium.com",
  "substack.com",
  "quora.com"
] as const;

/** Preferred recipe publishers — ranked ahead of unknown hosts. */
const PREFERRED_HOST_FRAGMENTS = [
  "punchdrink.com",
  "liquor.com",
  "diffordsguide.com",
  "imbibe.com",
  "seriouseats.com",
  "nytcooking.com",
  "cooking.nytimes.com",
  "epicurious.com",
  "foodandwine.com",
  "bonappetit.com",
  "bbcgoodfood.com",
  "thekitchn.com",
  "iba-world.com",
  "cocktailpartyapp.com",
  "deathandco.com",
  "sazerac.com",
  "campari.com",
  "hendricksgin.com"
] as const;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function asList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function hasType(node: unknown, type: string): boolean {
  if (!node || typeof node !== "object") return false;
  const raw = (node as { "@type"?: unknown })["@type"];
  return asList(raw).some((entry) => String(entry).toLowerCase() === type.toLowerCase());
}

function collectNodes(value: unknown, into: unknown[] = []): unknown[] {
  if (value == null) return into;
  if (Array.isArray(value)) {
    for (const entry of value) collectNodes(entry, into);
    return into;
  }
  if (typeof value === "object") {
    into.push(value);
    const record = value as Record<string, unknown>;
    if (record["@graph"]) collectNodes(record["@graph"], into);
  }
  return into;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function imageFrom(value: unknown, base: string): string {
  if (!value) return "";
  if (typeof value === "string") {
    try {
      return new URL(value, base).href;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return imageFrom(value[0], base);
  if (typeof value === "object" && value && "url" in value) {
    return imageFrom((value as { url: unknown }).url, base);
  }
  return "";
}

function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host: string, fragments: readonly string[]): boolean {
  return fragments.some((frag) => host.includes(frag));
}

/** Punctuation/case-normalized cocktail identity token string. */
export function normalizeCocktailName(name: string): string {
  return text(name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Exact identity only (after normalize). Derivative names like
 * "Smoked Old Fashioned" do not match "Old Fashioned".
 */
export function cocktailNamesMatchExact(candidate: string, target: string): boolean {
  const a = normalizeCocktailName(candidate);
  const b = normalizeCocktailName(target);
  return Boolean(a) && a === b;
}

/**
 * Soften a page title into a candidate drink identity by stripping site branding
 * and generic recipe boilerplate — not drink modifiers.
 *
 * Site separators `|`, `·`, and `•` may drop publisher branding
 * (e.g. "Old Fashioned Cocktail Recipe | Liquor.com").
 * Do NOT strip after `-` / `–` / `—`: those often carry drink modifiers
 * ("Old Fashioned – Smoked Version") and must stay part of identity.
 */
export function softTitleCocktailIdentity(title: string): string {
  const main = (text(title).split(/\s*[|·•]\s*/)[0] ?? text(title)).trim();
  let n = normalizeCocktailName(main);
  n = n.replace(/^(the|a|an)\s+/, "");
  for (let i = 0; i < 3; i++) {
    const next = n
      .replace(/^(how to make|make|best|homemade)\s+/, "")
      .replace(/\s+(recipe|cocktail|drink|cocktails)$/, "")
      .trim();
    if (next === n) break;
    n = next;
  }
  return n;
}

export function isRejectedCocktailImageHost(urlOrHost: string): boolean {
  const host = parseHost(urlOrHost) ?? urlOrHost.replace(/^www\./i, "").toLowerCase();
  if (!host) return true;
  return hostMatches(host, REJECTED_HOST_FRAGMENTS);
}

export function isPreferredCocktailRecipeHost(urlOrHost: string): boolean {
  const host = parseHost(urlOrHost) ?? urlOrHost.replace(/^www\./i, "").toLowerCase();
  if (!host) return false;
  return hostMatches(host, PREFERRED_HOST_FRAGMENTS);
}

export function cocktailHasImage(row: { image_url?: string | null } | null | undefined): boolean {
  return Boolean(text(row?.image_url));
}

/** Prefer a localized path; never persist a failed remote hotlink. */
export function acceptLocalizedCocktailImage(
  localized: string | null | undefined,
  original?: string | null
): string {
  if (isLocalImagePath(localized)) return String(localized);
  if (isLocalImagePath(original)) return String(original);
  return "";
}

type JsonLdRecipe = { name: string; image_url: string };

function parseJsonLdRecipes(html: string, pageUrl: string): JsonLdRecipe[] {
  const recipes: JsonLdRecipe[] = [];
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const node of collectNodes(parsed)) {
        if (!hasType(node, "Recipe")) continue;
        const record = node as Record<string, unknown>;
        const name = stripTags(String(record.name ?? ""));
        if (!name) continue;
        recipes.push({
          name,
          image_url: imageFrom(record.image, pageUrl)
        });
      }
    } catch {
      // Malformed JSON-LD on some blogs.
    }
  }
  return recipes;
}

function pageHeadingTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const textValue = stripTags(match[1] ?? "");
    if (textValue) out.push(textValue);
  }
  return out;
}

/**
 * Whether a page strongly identifies the intended cocktail.
 * Accepts exact JSON-LD Recipe name, exact heading, or softened title identity.
 */
export function pageIdentifiesCocktail(html: string, cocktailName: string): boolean {
  const target = normalizeCocktailName(cocktailName);
  if (!target) return false;

  for (const recipe of parseJsonLdRecipes(html, "https://example.invalid/")) {
    if (cocktailNamesMatchExact(recipe.name, cocktailName)) return true;
  }

  for (const heading of pageHeadingTexts(html)) {
    if (cocktailNamesMatchExact(heading, cocktailName)) return true;
    if (softTitleCocktailIdentity(heading) === target) return true;
  }

  const ogTitle = metaContent(html, "og:title");
  const title = ogTitle || stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (title && softTitleCocktailIdentity(title) === target) return true;

  return false;
}

/**
 * Conservative image extraction from a verified recipe page.
 * Order: Recipe JSON-LD image → og:image → twitter:image.
 * Does not scrape arbitrary <img> tags.
 */
export function extractCocktailRecipeImage(html: string, pageUrl: string, cocktailName?: string): string {
  const recipes = parseJsonLdRecipes(html, pageUrl);
  const matched = cocktailName
    ? recipes.find((recipe) => cocktailNamesMatchExact(recipe.name, cocktailName))
    : recipes[0];
  if (matched?.image_url) {
    try {
      return new URL(matched.image_url, pageUrl).href;
    } catch {
      return matched.image_url;
    }
  }

  const og = metaContent(html, "og:image") || metaContent(html, "twitter:image");
  if (!og) return "";
  try {
    return new URL(og, pageUrl).href;
  } catch {
    return og;
  }
}

/**
 * For recipe import: fill image from page metadata when the parser left it empty.
 * Additive — never replaces a non-empty image_url on the recipe object.
 */
export function enrichImportedRecipeImage(
  recipe: ImportedRecipe,
  html: string,
  pageUrl: string
): ImportedRecipe {
  if (text(recipe.image_url)) return recipe;
  const image = extractCocktailRecipeImage(html, pageUrl, recipe.name);
  if (!image) return recipe;
  return { ...recipe, image_url: image };
}

export function buildCocktailImageSearchQuery(name: string, notes?: string | null): string {
  const drink = text(name);
  if (!drink) return "";
  const originHint = text(notes).match(/\b(?:sam ross|negroni|iba|death &? co|punch|difford)\b/i)?.[0];
  if (originHint && !new RegExp(originHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(drink)) {
    return `${drink} cocktail ${originHint} recipe`;
  }
  return `${drink} cocktail recipe`;
}

function rankSearchHit(hit: WebSearchHit): number {
  if (!hit.url || isRejectedCocktailImageHost(hit.url)) return -1;
  let score = 1;
  if (isPreferredCocktailRecipeHost(hit.url)) score += 10;
  const blob = `${hit.title} ${hit.content}`.toLowerCase();
  if (/\brecipe\b/.test(blob)) score += 2;
  if (/\bcocktail\b/.test(blob)) score += 1;
  return score;
}

export function filterCocktailImageSearchHits(hits: WebSearchHit[], cocktailName: string): WebSearchHit[] {
  const target = normalizeCocktailName(cocktailName);
  const scored = hits
    .map((hit) => ({ hit, score: rankSearchHit(hit) }))
    .filter((row) => row.score > 0)
    .filter((row) => {
      const titleId = softTitleCocktailIdentity(row.hit.title);
      if (titleId === target) return true;
      if (isPreferredCocktailRecipeHost(row.hit.url)) return true;
      // Reject obvious derivative titles early.
      if (titleId.includes(target) && titleId !== target) return false;
      return Boolean(row.hit.url);
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((row) => row.hit);
}

async function tryImageFromPage(
  pageUrl: string,
  cocktailName: string,
  deps: CocktailImageDiscoveryDeps
): Promise<{ imageUrl: string; sourceUrl: string } | null> {
  if (!pageUrl || isRejectedCocktailImageHost(pageUrl)) return null;
  const fetchHtml = deps.fetchHtml ?? fetchPublicHtml;
  let html: string;
  let finalUrl: string;
  try {
    const page = await fetchHtml(pageUrl);
    html = page.html;
    finalUrl = page.finalUrl || pageUrl;
  } catch {
    return null;
  }
  if (isRejectedCocktailImageHost(finalUrl)) return null;
  if (!pageIdentifiesCocktail(html, cocktailName)) return null;
  const imageUrl = extractCocktailRecipeImage(html, finalUrl, cocktailName);
  if (!imageUrl || isRejectedCocktailImageHost(imageUrl)) return null;
  return { imageUrl, sourceUrl: finalUrl };
}

async function localizeAccepted(
  remoteUrl: string,
  deps: CocktailImageDiscoveryDeps
): Promise<string> {
  const localize = deps.localizeImage ?? localizeImage;
  const localized = await localize(remoteUrl, deps.localizeImageDeps);
  return acceptLocalizedCocktailImage(localized, remoteUrl);
}

/**
 * Discover and localize a cocktail image without overwriting an existing one.
 */
export async function discoverCocktailImage(
  row: CocktailImageRow,
  deps: CocktailImageDiscoveryDeps = {}
): Promise<CocktailImageDiscoveryResult> {
  if (cocktailHasImage(row)) {
    return { status: "already_has_image", image_url: text(row.image_url) };
  }

  const name = text(row.name);
  if (!name) return { status: "no_result", reason: "missing_name" };

  const maxCandidates = deps.maxCandidates ?? 6;

  // Imported source page is strongest identity evidence — try it before any web search.
  const sourceUrl = text(row.source_url);
  if (sourceUrl && !isRejectedCocktailImageHost(sourceUrl)) {
    const fromSource = await tryImageFromPage(sourceUrl, name, deps);
    if (fromSource) {
      const local = await localizeAccepted(fromSource.imageUrl, deps);
      if (local) {
        return {
          status: "updated",
          image_url: local,
          source_url: fromSource.sourceUrl
        };
      }
    }
  }

  const candidates: string[] = [];
  const search = deps.searchWebHits ?? searchWebHits;
  try {
    const query = buildCocktailImageSearchQuery(name, row.notes);
    const hits = filterCocktailImageSearchHits(await search(query, 10), name);
    for (const hit of hits) {
      if (hit.url === sourceUrl) continue;
      candidates.push(hit.url);
      if (candidates.length >= maxCandidates) break;
    }
  } catch {
    return { status: "no_result", reason: "search_failed" };
  }

  for (const pageUrl of candidates) {
    const found = await tryImageFromPage(pageUrl, name, deps);
    if (!found) continue;
    const local = await localizeAccepted(found.imageUrl, deps);
    if (!local) continue;
    return {
      status: "updated",
      image_url: local,
      source_url: found.sourceUrl
    };
  }

  return { status: "no_result", reason: "no_trustworthy_source" };
}

export function loadCocktailImageRow(id: number): CocktailImageRow | null {
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = db.prepare(
    "SELECT id, name, image_url, source_url, ingredients, notes, collection FROM cocktails WHERE id = ?"
  ).get(id) as CocktailImageRow | undefined;
  return row ?? null;
}

/**
 * Keeper mutation: fill missing image_url only.
 * Updates the cocktail row when discovery succeeds.
 */
export async function findCocktailImage(
  cocktailId: number,
  deps: CocktailImageDiscoveryDeps = {}
): Promise<CocktailImageDiscoveryResult> {
  const row = loadCocktailImageRow(cocktailId);
  if (!row) {
    return { status: "no_result", reason: "not_found" };
  }
  const result = await discoverCocktailImage(row, deps);
  if (result.status !== "updated") return result;

  db.prepare(
    "UPDATE cocktails SET image_url = ? WHERE id = ? AND (image_url IS NULL OR trim(image_url) = '')"
  ).run(result.image_url, cocktailId);

  const after = loadCocktailImageRow(cocktailId);
  if (!after) return { status: "no_result", reason: "update_failed" };
  if (text(after.image_url) !== result.image_url) {
    return { status: "already_has_image", image_url: text(after.image_url) };
  }
  return result;
}
