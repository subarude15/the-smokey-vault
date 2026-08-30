import { db } from "../../db.js";
import { CACHE_TTL_SECONDS, isColaConfigured, type ProductSchema } from "../../cola_client.js";
import { getFromCache } from "./cola-cache-store.js";

export type ColaCacheResolution =
  | { kind: "hit"; product: ProductSchema }
  | { kind: "stale"; product: ProductSchema }
  | { kind: "miss" };

/**
 * COLA/FWGS/web product cache (`cola_cache` table).
 * Beer path accepts fresh non-COLA and COLA rows; spirits prefer cola_cloud/fwgs
 * (or any row when COLA is not configured). Otherwise a stale row may be kept
 * as a fallback after live catalog attempts.
 */
export function resolveColaCache(
  upc: string,
  options: { beerPath: boolean; forceRefresh?: boolean }
): ColaCacheResolution {
  if (options.forceRefresh) return { kind: "miss" };

  const cached = getFromCache(upc);
  if (!cached) return { kind: "miss" };

  const cacheMeta = db.prepare("SELECT source, cached_at FROM cola_cache WHERE upc = ?").get(upc) as
    | { source?: string; cached_at?: number }
    | undefined;
  const cacheSource = String(cacheMeta?.source ?? "");
  const age = Math.floor(Date.now() / 1000) - Number(cacheMeta?.cached_at ?? 0);
  const fresh = age <= CACHE_TTL_SECONDS;

  if (options.beerPath) {
    if (cacheSource !== "cola_cloud" && fresh) return { kind: "hit", product: cached };
    if (cacheSource === "cola_cloud" && fresh) return { kind: "hit", product: cached };
    return { kind: "stale", product: cached };
  }

  if (cacheSource === "cola_cloud" || cacheSource === "fwgs" || !isColaConfigured()) {
    return { kind: "hit", product: cached };
  }

  return { kind: "stale", product: cached };
}
