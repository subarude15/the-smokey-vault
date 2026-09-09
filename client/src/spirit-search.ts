import { parseList } from "./catalog";
import { flavorSearchAliases } from "./spirit-flavors";

/**
 * PR152 — Bottle Library free-text search + Guest-safe availability.
 *
 * Search is multi-word and field-spanning: the searchable text combines the
 * bottle's name, brand, family/category, subtype, base, notes, tasting notes,
 * structured flavors, DERIVED canonical flavors, and manual Keeper tags. Every
 * normalized query token must appear somewhere in that text (tokens may match
 * different fields), so "vanilla rum" matches a Rum whose derived flavors
 * include Vanilla. Matching is deterministic and case-insensitive — no AI,
 * network, or fuzzy ranking.
 */
export function bottleSearchHaystack(item: Record<string, unknown>, derivedFlavors: string[] = []): string {
  const parts: unknown[] = [
    item.name,
    item.brand,
    item.producer,
    item.category,
    item.sub_category,
    item.base_ingredient,
    item.style,
    item.notes,
    item.tasting_notes,
    ...parseList(item.flavors),
    ...derivedFlavors,
    ...flavorSearchAliases(derivedFlavors),
    ...parseList(item.tags)
  ];
  return parts.map((part) => String(part ?? "")).join(" ").toLowerCase();
}

export function matchesBottleSearch(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Guest-safe availability. Prefers the derived `out_of_stock` flag present in
 * Guest responses; falls back to Keeper stock/fill signals. Never reads or
 * exposes exact Keeper-only quantities beyond a boolean on/off state.
 */
export function spiritIsAvailable(item: Record<string, unknown>): boolean {
  const flag = item.out_of_stock;
  if (flag === true || flag === 1 || flag === "1") return false;
  if (flag === false || flag === 0 || flag === "0") return true;
  const stock = Number(item.stock_count);
  if (Number.isFinite(stock) && stock > 0) return true;
  const fill = Number(item.fill_level);
  if (Number.isFinite(fill) && fill > 0) return true;
  // No availability signal at all → treat as available (don't hide bottles).
  return !(Number.isFinite(stock) || Number.isFinite(fill));
}
