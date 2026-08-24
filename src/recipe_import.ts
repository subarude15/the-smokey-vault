import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type ImportedRecipe = {
  name: string;
  ingredients: string[];
  method: string;
  glassware: string;
  garnish: string;
  season: string;
  notes: string;
  image_url: string;
  source_url: string;
};

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal"
]);

export class RecipeImportError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export function assertSafeHttpUrl(raw: string, base?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim(), base);
  } catch {
    throw new RecipeImportError("That does not look like a web link.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RecipeImportError("Use an http or https recipe link.");
  }
  if (parsed.username || parsed.password) {
    throw new RecipeImportError("That link cannot be opened.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new RecipeImportError("That link cannot be opened.");
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new RecipeImportError("That link cannot be opened.");
  }
  return parsed;
}

export function isPrivateIp(ip: string): boolean {
  const value = ip.toLowerCase().replace(/^::ffff:/, "");
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

export async function assertPublicHostname(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new RecipeImportError("That link cannot be opened.");
    return;
  }
  try {
    const results = await lookup(host, { all: true });
    if (!results.length || results.some((entry) => isPrivateIp(entry.address))) {
      throw new RecipeImportError("That link cannot be opened.");
    }
  } catch (error) {
    if (error instanceof RecipeImportError) throw error;
    throw new RecipeImportError("Could not reach that site.");
  }
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

function imageFrom(value: unknown, base: string): string {
  if (!value) return "";
  if (typeof value === "string") {
    try { return new URL(value, base).href; } catch { return value; }
  }
  if (Array.isArray(value)) return imageFrom(value[0], base);
  if (typeof value === "object" && value && "url" in value) return imageFrom((value as { url: unknown }).url, base);
  return "";
}

function stringList(value: unknown): string[] {
  const result: string[] = [];
  for (const entry of asList(value)) {
    if (typeof entry === "string") {
      const text = stripTags(entry);
      if (text) result.push(text);
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const text = stripTags(String(record.text ?? record.name ?? ""));
      if (text) result.push(text);
    }
  }
  return result;
}

function methodFrom(value: unknown): string {
  if (typeof value === "string") return stripTags(value);
  if (Array.isArray(value)) return value.map((step) => methodFrom(step)).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.text) return stripTags(String(record.text));
    if (record.itemListElement) return methodFrom(record.itemListElement);
  }
  return "";
}

export function metaContent(html: string, key: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return "";
}

function parseJsonLdRecipes(html: string, pageUrl: string): ImportedRecipe[] {
  const recipes: ImportedRecipe[] = [];
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
        const ingredients = stringList(record.recipeIngredient ?? record.ingredients);
        const name = stripTags(String(record.name ?? ""));
        if (!name || !ingredients.length) continue;
        recipes.push({
          name,
          ingredients,
          method: methodFrom(record.recipeInstructions ?? record.instructions) || "See the linked recipe.",
          glassware: stripTags(String(record.recipeCategory ?? record.cookingMethod ?? "")) || "Coupe",
          garnish: "",
          season: "All",
          notes: stripTags(String(record.description ?? "")).slice(0, 400),
          image_url: imageFrom(record.image, pageUrl),
          source_url: pageUrl
        });
      }
    } catch {
      // Malformed JSON-LD on some blogs.
    }
  }
  return recipes;
}

export function parseRecipeHtml(html: string, pageUrl: string): ImportedRecipe {
  const fromLd = parseJsonLdRecipes(html, pageUrl)[0];
  if (fromLd) {
    fromLd.image_url ||= metaContent(html, "og:image") || metaContent(html, "twitter:image");
    if (fromLd.image_url) {
      try { fromLd.image_url = new URL(fromLd.image_url, pageUrl).href; } catch { /* keep */ }
    }
    fromLd.glassware = /glass|coupe|rocks|highball|flute|collins|mug|julep|nick|nora|wine|tiki|hurricane/i.test(fromLd.glassware)
      ? fromLd.glassware
      : "Coupe";
    return fromLd;
  }
  const name = metaContent(html, "og:title") || stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  if (!name) throw new RecipeImportError("No recipe was found on that page. Try a recipe site, or add it by hand.");
  throw new RecipeImportError("That page has a title but no ingredient list the vault can read. Try a different recipe link.");
}

export async function fetchPublicHtml(url: string, fetchImpl: typeof fetch = fetch): Promise<{ html: string; finalUrl: string }> {
  let current = assertSafeHttpUrl(url);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHostname(current.hostname);
    const response = await fetchImpl(current.href, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": "TheSmokeyVault/1.0 (+https://github.com/subarude15/the-smokey-vault)"
      },
      signal: AbortSignal.timeout(12_000)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new RecipeImportError("The page redirected without a destination.", 502);
      current = assertSafeHttpUrl(location, current.href);
      continue;
    }
    if (!response.ok) throw new RecipeImportError(`Could not read that page (${response.status}).`, 502);
    const type = response.headers.get("content-type") ?? "text/html";
    if (!/html|xhtml|xml|json|text\//i.test(type)) {
      throw new RecipeImportError("That link is not a web page with a recipe.");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 1_500_000) throw new RecipeImportError("That page is too large to import.");
    return { html: buffer.toString("utf8"), finalUrl: current.href };
  }
  throw new RecipeImportError("Too many redirects from that link.", 502);
}

export function recipeTextForAi(html: string): string {
  return stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")).slice(0, 8000);
}
