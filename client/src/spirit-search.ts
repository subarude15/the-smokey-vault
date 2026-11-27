import { isZeroStockShelfItem, packagedCount, parseList } from "./catalog";
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
  const hasStock = item.stock_count != null && String(item.stock_count).trim() !== "";
  const hasFill = item.fill_level != null && String(item.fill_level).trim() !== "";
  const stock = hasStock ? Number(item.stock_count) : Number.NaN;
  const fill = hasFill ? Number(item.fill_level) : Number.NaN;
  if (Number.isFinite(stock) && stock <= 0) return false;
  if (Number.isFinite(stock) && stock > 1) return true;
  if (Number.isFinite(fill)) return fill > 0;
  if (Number.isFinite(stock)) return stock > 0;
  // No availability signal at all → treat as available (don't hide bottles).
  return true;
}

export function shelfItemIsAvailable(moduleId: string, item: Record<string, unknown>): boolean {
  if (moduleId === "spirits") return spiritIsAvailable(item);
  const flag = item.out_of_stock;
  if (flag === true || flag === 1 || flag === "1") return false;
  if (flag === false || flag === 0 || flag === "0") return true;
  if (moduleId === "wines") {
    if (item.bottle_count == null || String(item.bottle_count).trim() === "") return true;
    return Math.max(0, Math.floor(Number(item.bottle_count))) > 0;
  }
  if (moduleId === "packaged_beer") {
    if (item.count == null || String(item.count).trim() === "") return true;
    return packagedCount(item.count) > 0;
  }
  return true;
}

export function shelfItemMatchesAvailability(
  moduleId: string,
  item: Record<string, unknown>,
  avail: string,
  admin: boolean
): boolean {
  if (!avail || avail === "All") return true;
  if (avail === "zero") {
    if (!admin) return true;
    return isZeroStockShelfItem(moduleId, item);
  }
  const available = shelfItemIsAvailable(moduleId, item);
  if (avail === "available") return available;
  if (avail === "out") return !available;
  return true;
}
