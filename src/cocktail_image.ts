/**
 * PR129 — Conservative cocktail recipe imagery.
 *
 * Fill-missing only: never overwrite an existing cocktail image_url.
 * Prefer imagery from an imported recipe's own source page; otherwise search
 * for an exact-named cocktail recipe page and extract Recipe JSON-LD / OG image.
 * Always localize through existing image safety helpers before saving.
 */
import { parseList } from "./catalog.js";
import { db, getSetting, setSetting } from "./db.js";
import { isLocalImagePath, localizeImage, type LocalizeImageDeps } from "./images.js";
import { searchWebHits, type WebSearchHit } from "./ingestion/web-search.js";
import {
  fetchPublicHtml,
  metaContent,
  type ImportedRecipe
} from "./recipe_import.js";
import {
  buildCocktailImageQueryPlan,
  classifyCocktailIdentity,
  cocktailIdentityAccepted,
  normalizeCocktailName,
  softTitleCocktailIdentity
} from "./cocktail-image-identity.js";

// Identity helpers now live in the pure identity module; re-export for callers
// and existing tests that import them from here.
export {
  cocktailNamesMatchExact,
  normalizeCocktailName,
  softTitleCocktailIdentity
} from "./cocktail-image-identity.js";
export type { CocktailIdentityTier } from "./cocktail-image-identity.js";

/** Bounded, user-readable reasons a discovery attempt produced no image. */
export type CocktailImageNoResultReason =
  | "missing_name"
  | "not_found"
  | "update_failed"
  | "search_failed"
  | "search_miss"
  | "identity_rejected"
  | "no_page_image"
  | "localize_failed";

export type CocktailImageDiscoveryResult =
  | { status: "updated"; image_url: string; source_url?: string }
  | { status: "no_result"; reason?: CocktailImageNoResultReason }
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

type JsonLdRecipe = { name: string; image_url: string; ingredients: string[] };

function ingredientStrings(value: unknown): string[] {
  return asList(value)
    .map((entry) => stripTags(String(entry ?? "")))
    .filter(Boolean);
}

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
          image_url: imageFrom(record.image, pageUrl),
          ingredients: ingredientStrings(record.recipeIngredient ?? record.ingredients)
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
 * Accepts exact identity, or a base-spirit alias confirmed by the requested
 * drink's own ingredients (PR154). JSON-LD Recipe names are checked with their
 * own ingredients so flavored variants (e.g. Strawberry Basil Smash) are
 * rejected; headings/titles fall back to name-only identity.
 */
export function pageIdentifiesCocktail(
  html: string,
  cocktailName: string,
  targetIngredients: readonly string[] = []
): boolean {
  const target = normalizeCocktailName(cocktailName);
  if (!target) return false;

  const recipes = parseJsonLdRecipes(html, "https://example.invalid/");
  for (const recipe of recipes) {
    const result = classifyCocktailIdentity({
      target: cocktailName,
      candidate: recipe.name,
      targetIngredients,
      candidateIngredients: recipe.ingredients
    });
    if (cocktailIdentityAccepted(result)) return true;
  }

  // Heading/title matches must still respect the page's recipe ingredients so an
  // exact-named page whose Recipe adds a flavor modifier (e.g. strawberry) is
  // rejected rather than accepted on the clean heading alone.
  const pageIngredients = recipes.flatMap((recipe) => recipe.ingredients);

  for (const heading of pageHeadingTexts(html)) {
    if (cocktailIdentityAccepted(classifyCocktailIdentity({
      target: cocktailName,
      candidate: heading,
      targetIngredients,
      candidateIngredients: pageIngredients
    }))) {
      return true;
    }
  }

  const ogTitle = metaContent(html, "og:title");
  const title = ogTitle || stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (title && cocktailIdentityAccepted(classifyCocktailIdentity({
    target: cocktailName,
    candidate: title,
    targetIngredients,
    candidateIngredients: pageIngredients
  }))) {
    return true;
  }

  return false;
}

/**
 * Conservative image extraction from a verified recipe page.
 * Order: Recipe JSON-LD image → og:image → twitter:image.
 * Does not scrape arbitrary <img> tags.
 */
export function extractCocktailRecipeImage(
  html: string,
  pageUrl: string,
  cocktailName?: string,
  targetIngredients: readonly string[] = []
): string {
  const recipes = parseJsonLdRecipes(html, pageUrl);
  const matched = cocktailName
    ? recipes.find((recipe) => cocktailIdentityAccepted(classifyCocktailIdentity({
        target: cocktailName,
        candidate: recipe.name,
        targetIngredients,
        candidateIngredients: recipe.ingredients
      })))
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

export function filterCocktailImageSearchHits(
  hits: WebSearchHit[],
  cocktailName: string,
  targetIngredients: readonly string[] = []
): WebSearchHit[] {
  const target = normalizeCocktailName(cocktailName);
  const scored = hits
    .map((hit) => ({ hit, score: rankSearchHit(hit) }))
    .filter((row) => row.score > 0)
    .filter((row) => {
      if (!row.hit.url) return false;
      const identity = classifyCocktailIdentity({
        target: cocktailName,
        candidate: row.hit.title,
        targetIngredients
      });
      // Exact/alias titles are always eligible (the page gate still verifies).
      if (cocktailIdentityAccepted(identity)) return true;
      // Drop titles that are clearly a derivative/variant OF this drink.
      const titleId = softTitleCocktailIdentity(row.hit.title);
      if (titleId.includes(target) && titleId !== target) return false;
      // Unrelated-but-not-derivative titles (and preferred hosts) reach the page gate.
      return true;
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((row) => row.hit);
}

type CocktailPageAttempt =
  | { stage: "ok"; imageUrl: string; sourceUrl: string }
  | { stage: "skip" } // rejected host or fetch failure
  | { stage: "identity" } // fetched, but not the requested cocktail
  | { stage: "no_image" }; // identified, but no usable Recipe/OG image

async function tryImageFromPage(
  pageUrl: string,
  cocktailName: string,
  targetIngredients: readonly string[],
  deps: CocktailImageDiscoveryDeps
): Promise<CocktailPageAttempt> {
  if (!pageUrl || isRejectedCocktailImageHost(pageUrl)) return { stage: "skip" };
  const fetchHtml = deps.fetchHtml ?? fetchPublicHtml;
  let html: string;
  let finalUrl: string;
  try {
    const page = await fetchHtml(pageUrl);
    html = page.html;
    finalUrl = page.finalUrl || pageUrl;
  } catch {
    return { stage: "skip" };
  }
  if (isRejectedCocktailImageHost(finalUrl)) return { stage: "skip" };
  if (!pageIdentifiesCocktail(html, cocktailName, targetIngredients)) return { stage: "identity" };
  const imageUrl = extractCocktailRecipeImage(html, finalUrl, cocktailName, targetIngredients);
  if (!imageUrl || isRejectedCocktailImageHost(imageUrl)) return { stage: "no_image" };
  return { stage: "ok", imageUrl, sourceUrl: finalUrl };
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

  const targetIngredients = parseList(row.ingredients);
  const maxCandidates = deps.maxCandidates ?? 6;

  // Furthest stage reached, for a specific Keeper-facing diagnostic.
  let sawIdentityReject = false;
  let sawNoImage = false;
  let sawLocalizeFail = false;

  async function attemptPage(pageUrl: string): Promise<CocktailImageDiscoveryResult | null> {
    const attempt = await tryImageFromPage(pageUrl, name, targetIngredients, deps);
    if (attempt.stage === "ok") {
      const local = await localizeAccepted(attempt.imageUrl, deps);
      if (local) return { status: "updated", image_url: local, source_url: attempt.sourceUrl };
      sawLocalizeFail = true;
    } else if (attempt.stage === "identity") {
      sawIdentityReject = true;
    } else if (attempt.stage === "no_image") {
      sawNoImage = true;
    }
    return null;
  }

  // Imported source page is strongest identity evidence — try it before any web search.
  const sourceUrl = text(row.source_url);
  if (sourceUrl && !isRejectedCocktailImageHost(sourceUrl)) {
    const fromSource = await attemptPage(sourceUrl);
    if (fromSource) return fromSource;
  }

  // Bounded, deterministic query plan: exact → base-spirit alias → ingredient-assisted.
  const search = deps.searchWebHits ?? searchWebHits;
  const baseQuery = buildCocktailImageSearchQuery(name, row.notes);
  const queries = buildCocktailImageQueryPlan(name, targetIngredients, baseQuery);
  const seen = new Set<string>();
  if (sourceUrl) seen.add(sourceUrl);
  const candidates: string[] = [];
  let anyHits = false;
  for (const query of queries) {
    let hits: WebSearchHit[];
    try {
      hits = filterCocktailImageSearchHits(await search(query, 10), name, targetIngredients);
    } catch {
      return { status: "no_result", reason: "search_failed" };
    }
    if (hits.length) anyHits = true;
    for (const hit of hits) {
      if (!hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      candidates.push(hit.url);
    }
    if (candidates.length >= maxCandidates) break;
  }
  const limited = candidates.slice(0, maxCandidates);

  for (const pageUrl of limited) {
    const found = await attemptPage(pageUrl);
    if (found) return found;
  }

  const reason: CocktailImageNoResultReason = sawLocalizeFail
    ? "localize_failed"
    : sawNoImage
      ? "no_page_image"
      : sawIdentityReject || anyHits
        ? "identity_rejected"
        : "search_miss";
  return { status: "no_result", reason };
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

/** Settings key holding the id of the last cocktail attempted by the boot image backfill. */
export const COCKTAIL_IMAGE_BACKFILL_CURSOR = "cocktailImageBackfillCursor";

/** Ordered batch of eligible cocktail ids starting just after `cursor`, wrapping around. */
export function selectCocktailImageBackfillBatch(cursor: number, limit: number): number[] {
  const eligible = "(image_url IS NULL OR trim(image_url) = '') AND collection != 'Custom Cocktails'";
  const after = db
    .prepare(`SELECT id FROM cocktails WHERE ${eligible} AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(cursor, limit) as { id: number }[];

  const ids = after.map((row) => row.id);
  if (ids.length < limit) {
    // Wrap to the front so persistent no-results near the start cannot starve later rows.
    const seen = new Set(ids);
    const wrapped = db
      .prepare(`SELECT id FROM cocktails WHERE ${eligible} AND id <= ? ORDER BY id ASC LIMIT ?`)
      .all(cursor, limit) as { id: number }[];
    for (const row of wrapped) {
      if (seen.has(row.id)) continue;
      ids.push(row.id);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}

/**
 * Bounded, fill-missing backfill of built-in cocktail photos (PR145).
 *
 * Reuses the existing safe discovery (`findCocktailImage`), which only writes when
 * a trustworthy image is localized and never overwrites an existing image. Custom
 * cocktails are skipped so Keeper-owned imagery is left untouched.
 *
 * A persisted cursor (last attempted id) advances every run and wraps around, so
 * each boot works through the next slice of eligible cocktails instead of retrying
 * the same leading rows forever. Cocktails that return no result stay eligible and
 * are revisited only after the cursor has rotated through the rest — preventing
 * starvation. Safe to run in the background at boot.
 */
export async function backfillMissingCocktailImages(opts?: {
  limit?: number;
  log?: (message: string) => void;
  findImage?: (id: number) => Promise<CocktailImageDiscoveryResult>;
}): Promise<{ attempted: number; updated: number }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 6, 50));
  const findImage = opts?.findImage ?? ((id: number) => findCocktailImage(id));

  const cursorRaw = Number(getSetting(COCKTAIL_IMAGE_BACKFILL_CURSOR) ?? 0);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? Math.floor(cursorRaw) : 0;

  const ids = selectCocktailImageBackfillBatch(cursor, limit);

  let attempted = 0;
  let updated = 0;
  for (const id of ids) {
    attempted += 1;
    // Advance the cursor before the (possibly slow/failing) lookup so a crash mid-run
    // still moves forward on the next boot rather than re-attempting the same row.
    setSetting(COCKTAIL_IMAGE_BACKFILL_CURSOR, String(id));
    try {
      const result = await findImage(id);
      if (result.status === "updated") updated += 1;
    } catch (error) {
      opts?.log?.(`cocktail image backfill failed for #${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { attempted, updated };
}
