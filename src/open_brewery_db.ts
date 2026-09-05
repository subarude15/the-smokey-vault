/**
 * Open Brewery DB brewery resolver — identity hints only.
 *
 * Answers: which brewery a query/candidate likely refers to.
 * Never invents beer products or BottleSearchHit rows.
 */

import {
  beerTextTokens,
  classifyBeerMatch,
  foldBeerText
} from "./beer_search_query.js";
import type { ParsedBeerQuery } from "./beer_search_query.js";

/** Local sources whose strong brewery+beer identity can skip OBDB. */
const STRONG_LOCAL_SOURCES = new Set(["vault", "beer_cache"]);

/** Match classes that already establish brewery identity without OBDB. */
const STRONG_MATCH_CLASSES = new Set(["exact_identity", "name_and_brewery"]);

function debugLog(msg: string, fields: Record<string, unknown> = {}): void {
  console.debug(JSON.stringify({ level: "debug", msg, ...fields }));
}

export type BreweryResolverHit = {
  id: string;
  name: string;
  breweryType: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  websiteUrl: string | null;
  websiteHost: string | null;
};

export type BreweryMatchStrength = "exact" | "strong" | "none";

type CacheEntry = {
  hits: BreweryResolverHit[];
  expiresAt: number;
  lastAccessAt: number;
};

const DEFAULT_BASE_URL = "https://api.openbrewerydb.org";
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESULTS_PER_QUERY = 8;
const MAX_QUERIES_PER_SEARCH = 2;

/** Longer phrases first so "independent brewing" wins before bare "brewing". */
const BREWERY_SUFFIX_PHRASES = [
  "independent brewing company",
  "independent brewing co",
  "independent brewing",
  "independent brewery",
  "craft brewery",
  "brewing company",
  "brewing co",
  "beer company",
  "beer co",
  "brewery",
  "brewing",
  "brewpubs",
  "brewpub",
  "brewers",
  "brewer"
] as const;

const PRODUCTISH_TOKENS = new Set([
  "ipa",
  "pale",
  "ale",
  "lager",
  "stout",
  "porter",
  "pils",
  "pilsner",
  "wheat",
  "wit",
  "saison",
  "sour",
  "gose",
  "kolsch",
  "hefeweizen",
  "double",
  "triple",
  "imperial",
  "session",
  "light",
  "dark",
  "amber",
  "blonde",
  "brown",
  "black",
  "red",
  "white",
  "golden",
  "monkey",
  "hearted",
  "minute",
  "perpetual",
  "brawler",
  "ranger",
  "voodoo"
]);

const cache = new Map<string, CacheEntry>();

export function isOpenBreweryDbEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OPEN_BREWERY_DB_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

export function openBreweryDbBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.OPEN_BREWERY_DB_BASE_URL ?? "").trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_BASE_URL;
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function clearOpenBreweryDbCacheForTests(): void {
  cache.clear();
}

export function openBreweryDbCacheSizeForTests(): number {
  return cache.size;
}

/** Comparison-only: fold + strip common legal/company brewery suffixes. */
export function breweryCompareKey(value: string): string {
  const folded = foldBeerText(value);
  if (!folded) return "";
  let out = ` ${folded} `;
  for (const phrase of BREWERY_SUFFIX_PHRASES) {
    out = out.replace(new RegExp(`\\s${escapeRegExp(phrase)}\\s`, "g"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

export function scoreBreweryNameMatch(left: string, right: string): BreweryMatchStrength {
  const a = foldBeerText(left);
  const b = foldBeerText(right);
  if (!a || !b) return "none";
  if (a === b) return "exact";

  const aCore = breweryCompareKey(left);
  const bCore = breweryCompareKey(right);
  if (aCore && bCore && aCore === bCore) return "exact";

  const aTokens = beerTextTokens(aCore || a);
  const bTokens = beerTextTokens(bCore || b);
  if (aTokens.length === 0 || bTokens.length === 0) return "none";

  // Short single-token names must be exact core equality — no substring.
  if (aTokens.length === 1 && aTokens[0]!.length <= 5) {
    return bTokens.length === 1 && aTokens[0] === bTokens[0] ? "exact" : "none";
  }
  if (bTokens.length === 1 && bTokens[0]!.length <= 5) {
    return aTokens.length === 1 && aTokens[0] === bTokens[0] ? "exact" : "none";
  }

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const shorter = aTokens.length <= bTokens.length ? aTokens : bTokens;
  const longerSet = aTokens.length <= bTokens.length ? bSet : aSet;
  if (shorter.every((t) => longerSet.has(t)) && shorter.some((t) => t.length >= 4)) {
    return "strong";
  }
  return "none";
}

export function breweryHintBonus(
  candidateBrewery: string,
  resolved: Array<{ name: string }>
): number {
  let best: BreweryMatchStrength = "none";
  for (const hit of resolved) {
    const strength = scoreBreweryNameMatch(candidateBrewery, hit.name);
    if (strength === "exact") return 40;
    if (strength === "strong") best = "strong";
  }
  return best === "strong" ? 25 : 0;
}

export function shouldAttemptBreweryResolution(parsed: ParsedBeerQuery): boolean {
  if (parsed.nonStyleTokens.length === 0) return false;
  // Need at least one meaningful brewery-ish token (not product/style noise, not digits).
  return parsed.nonStyleTokens.some(
    (t) => t.length >= 4 && !PRODUCTISH_TOKENS.has(t) && !/^\d+$/.test(t)
  );
}

/**
 * Deterministic gate: call OBDB only when existing beer hits do not already
 * establish a strong local brewery identity (Vault / beer_cache).
 *
 * Skip when a strong local exact_identity or name_and_brewery hit exists and
 * those strong locals agree on brewery. Still run when candidates disagree,
 * only weak/brewery-only matches exist, or only remote hits are present.
 */
export function breweryResolutionNeeded(
  hits: Array<{ source: string; product: Record<string, unknown> }>,
  parsed: ParsedBeerQuery
): boolean {
  if (hits.length === 0) return false;
  if (!shouldAttemptBreweryResolution(parsed)) return false;

  const strongLocal = hits.filter((hit) => {
    if (!STRONG_LOCAL_SOURCES.has(hit.source)) return false;
    return STRONG_MATCH_CLASSES.has(classifyBeerMatch(hit.product, parsed));
  });

  // No strong local brewery+beer identity — OBDB may help disambiguate.
  if (strongLocal.length === 0) return true;

  // Strong local identity exists. Only call OBDB if those strong locals disagree.
  const breweryKeys = new Set<string>();
  for (const hit of strongLocal) {
    const brewery = String(
      hit.product.brewery ?? hit.product.brand ?? hit.product.producer ?? ""
    ).trim();
    const key = breweryCompareKey(brewery);
    if (key) breweryKeys.add(key);
  }
  return breweryKeys.size > 1;
}

export function buildBreweryResolverQueries(
  parsed: ParsedBeerQuery,
  candidateBreweries: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const folded = foldBeerText(raw);
    if (!folded || folded.length < 3) return;
    const tokens = beerTextTokens(folded).filter((t) => !PRODUCTISH_TOKENS.has(t) && !/^\d+$/.test(t));
    if (tokens.length === 0) return;
    if (!tokens.some((t) => t.length >= 4)) return;
    const key = tokens.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tokens.join(" "));
  };

  for (const brewery of candidateBreweries) {
    push(brewery);
    if (out.length >= MAX_QUERIES_PER_SEARCH) return out;
  }

  // Cautious prefix from non-style tokens when no candidate brewery exists.
  if (out.length === 0 && parsed.nonStyleTokens.length > 0) {
    const prefix = parsed.nonStyleTokens
      .filter((t) => !PRODUCTISH_TOKENS.has(t) && !/^\d+$/.test(t))
      .slice(0, 3);
    if (prefix.length > 0) push(prefix.join(" "));
  }

  return out.slice(0, MAX_QUERIES_PER_SEARCH);
}

/** Parse/normalize untrusted brewery website URLs — never fetch them. */
export function normalizeWebsiteHost(websiteUrl: string | null | undefined): string | null {
  const raw = String(websiteUrl ?? "").trim();
  if (!raw) return null;
  try {
    const u = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.trim().toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

function normalizeBreweryRow(row: unknown): BreweryResolverHit | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const name = String(r.name ?? "").trim();
  if (!id || !name) return null;

  const websiteUrlRaw = String(r.website_url ?? "").trim() || null;
  return {
    id,
    name,
    breweryType: String(r.brewery_type ?? "").trim() || null,
    city: String(r.city ?? "").trim() || null,
    state: String(r.state_province ?? r.state ?? "").trim() || null,
    country: String(r.country ?? "").trim() || null,
    websiteUrl: websiteUrlRaw,
    websiteHost: normalizeWebsiteHost(websiteUrlRaw)
  };
}

function cacheGet(key: string): BreweryResolverHit[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  entry.lastAccessAt = Date.now();
  return entry.hits;
}

function cacheSet(key: string, hits: BreweryResolverHit[]): void {
  const now = Date.now();
  cache.set(key, {
    hits,
    expiresAt: now + (hits.length > 0 ? POSITIVE_TTL_MS : EMPTY_TTL_MS),
    lastAccessAt: now
  });
  while (cache.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of cache) {
      if (v.lastAccessAt < oldestAt) {
        oldestAt = v.lastAccessAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

async function fetchBrewerySearch(
  query: string,
  opts?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }
): Promise<BreweryResolverHit[]> {
  const env = opts?.env ?? process.env;
  const base = openBreweryDbBaseUrl(env);
  const url = `${base}/v1/breweries/search?query=${encodeURIComponent(query)}`;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  debugLog("obdb_search", { query });

  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SmokeyVault/1.0 (+https://github.com/subarude15/the-smokey-vault)"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!res.ok) {
    debugLog("obdb_provider_error", { status: res.status, query });
    throw new Error(`Open Brewery DB HTTP ${res.status}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    debugLog("obdb_provider_error", { reason: "malformed_json", query });
    throw new Error("Open Brewery DB malformed JSON");
  }

  if (!Array.isArray(data)) {
    debugLog("obdb_provider_error", { reason: "non_array", query });
    return [];
  }

  const hits: BreweryResolverHit[] = [];
  for (const row of data) {
    const hit = normalizeBreweryRow(row);
    if (hit) hits.push(hit);
    if (hits.length >= MAX_RESULTS_PER_QUERY) break;
  }

  if (hits.length === 0) debugLog("obdb_no_result", { query });
  return hits;
}

/**
 * Search Open Brewery DB for a brewery query string.
 * Uses bounded in-memory cache. Never throws — returns [] on failure.
 */
export async function searchOpenBreweryDb(
  query: string,
  opts?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; skipCache?: boolean }
): Promise<BreweryResolverHit[]> {
  const env = opts?.env ?? process.env;
  if (!isOpenBreweryDbEnabled(env)) return [];

  const folded = foldBeerText(query);
  if (!folded || folded.length < 3) return [];

  const cacheKey = folded;
  if (!opts?.skipCache) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      debugLog("obdb_cache_hit", { query: folded, count: cached.length });
      return cached;
    }
  }

  try {
    const hits = await fetchBrewerySearch(folded, { fetchImpl: opts?.fetchImpl, env });
    if (!opts?.skipCache) cacheSet(cacheKey, hits);
    return hits;
  } catch (err) {
    debugLog("obdb_provider_error", {
      query: folded,
      error: err instanceof Error ? err.message : String(err)
    });
    // Do not cache failures long-term.
    return [];
  }
}

/**
 * Resolve brewery hints for a beer search. Bounded to 1–2 OBDB queries.
 * Returns resolved brewery hits used only as ranking hints.
 */
export async function resolveBreweryHints(opts: {
  parsed: ParsedBeerQuery;
  candidateBreweries: string[];
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<BreweryResolverHit[]> {
  const env = opts.env ?? process.env;
  if (!isOpenBreweryDbEnabled(env)) return [];
  if (!shouldAttemptBreweryResolution(opts.parsed)) return [];

  const queries = buildBreweryResolverQueries(opts.parsed, opts.candidateBreweries);
  if (queries.length === 0) return [];

  const resolved: BreweryResolverHit[] = [];
  const seenIds = new Set<string>();

  for (const q of queries) {
    const hits = await searchOpenBreweryDb(q, {
      fetchImpl: opts.fetchImpl,
      env
    });
    for (const hit of hits) {
      if (seenIds.has(hit.id)) continue;
      const strength = scoreBreweryNameMatch(q, hit.name);
      if (strength === "none") continue;
      seenIds.add(hit.id);
      resolved.push(hit);
    }
  }

  if (resolved.length > 0) {
    debugLog("obdb_resolved_brewery", {
      names: resolved.map((h) => h.name).slice(0, 3),
      count: resolved.length
    });
  }

  return resolved;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
