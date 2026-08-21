import { db } from "./db.js";
import {
  fillStopLabel,
  isSpiritEmpty,
  nearestFillStop,
  packagedCount,
  packagedStockLabel,
  spiritStockLabel
} from "./catalog.js";
import { spiritOnShelf, stripMeasure, wineOnShelf } from "./cocktails.js";

export type RestockKind = "spirits" | "wines" | "packaged_beer" | "ingredient";

export type RestockItem = {
  key: string;
  kind: RestockKind;
  name: string;
  reason: string;
  module?: RestockKind;
  id?: number;
  image_url: string;
  got: boolean;
};

db.exec(`
CREATE TABLE IF NOT EXISTS restock_got (
  key TEXT PRIMARY KEY,
  got INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

export function listRestockGot(): Set<string> {
  const rows = db.prepare("SELECT key FROM restock_got WHERE got=1").all() as Array<{ key: string }>;
  return new Set(rows.map((row) => row.key));
}

export function setRestockGot(key: string, got: boolean): void {
  const clean = String(key ?? "").trim();
  if (!clean || clean.length > 160) throw new Error("That restock item is not valid");
  if (got) {
    db.prepare("INSERT INTO restock_got(key,got) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET got=1,updated_at=CURRENT_TIMESTAMP").run(clean);
    return;
  }
  db.prepare("DELETE FROM restock_got WHERE key=?").run(clean);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function itemId(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function bottleName(item: Record<string, unknown>, secondary: string): string {
  return [text(item.name) || text(item.batch_name), text(item[secondary])].filter(Boolean).join(" · ") || "Untitled";
}

function needKey(ingredient: string): string {
  return `need:${stripMeasure(ingredient) || ingredient.toLowerCase().trim()}`;
}

function needLabel(ingredient: string): string {
  const stripped = stripMeasure(ingredient);
  const lower = ingredient.toLowerCase();
  const idx = stripped ? lower.lastIndexOf(stripped) : -1;
  if (idx >= 0) return ingredient.slice(idx).trim();
  return ingredient.trim();
}

export function buildRestockList(input: {
  spirits?: Array<Record<string, unknown>>;
  wines?: Array<Record<string, unknown>>;
  packaged?: Array<Record<string, unknown>>;
  cocktails?: Array<Record<string, unknown>>;
  got?: Iterable<string>;
}): RestockItem[] {
  const got = new Set(input.got ?? []);
  const items: RestockItem[] = [];

  for (const item of input.spirits ?? []) {
    const empty = isSpiritEmpty(item);
    const low = spiritOnShelf(item) && nearestFillStop(item.fill_level) <= 25;
    if (!empty && !low) continue;
    const fill = nearestFillStop(item.fill_level);
    items.push({
      key: `spirits:${itemId(item.id)}`,
      kind: "spirits",
      module: "spirits",
      id: itemId(item.id),
      name: bottleName(item, "brand"),
      reason: empty
        ? `Empty · ${spiritStockLabel(item.stock_count)}`
        : `${fillStopLabel(fill)} · ${spiritStockLabel(item.stock_count)}`,
      image_url: text(item.image_url),
      got: false
    });
  }

  for (const item of input.wines ?? []) {
    const count = Math.max(0, Math.floor(num(item.bottle_count)));
    if (count !== 1) continue;
    items.push({
      key: `wines:${itemId(item.id)}`,
      kind: "wines",
      module: "wines",
      id: itemId(item.id),
      name: bottleName(item, "producer"),
      reason: "Last bottle",
      image_url: text(item.image_url),
      got: false
    });
  }

  for (const item of input.packaged ?? []) {
    const count = packagedCount(item.count);
    if (count > 1) continue;
    items.push({
      key: `packaged_beer:${itemId(item.id)}`,
      kind: "packaged_beer",
      module: "packaged_beer",
      id: itemId(item.id),
      name: bottleName(item, "brewery"),
      reason: count <= 0 ? "Out of stock" : packagedStockLabel(count, item.vessel),
      image_url: text(item.image_url),
      got: false
    });
  }

  const needs = new Map<string, { label: string; drinks: string[] }>();
  function addNeed(ingredient: string, drinkName: string) {
    const key = needKey(ingredient);
    if (!key || key === "need:") return;
    const current = needs.get(key) ?? { label: needLabel(ingredient), drinks: [] };
    if (!current.drinks.includes(drinkName)) current.drinks.push(drinkName);
    needs.set(key, current);
  }

  for (const drink of input.cocktails ?? []) {
    const missing = Array.isArray(drink.missing) ? drink.missing.map((entry) => String(entry)) : [];
    if (!missing.length) continue;
    const name = text(drink.name) || "Untitled";
    const fav = num(drink.bartender_fav) > 0;
    const almost = drink.readiness === "almost";
    if (!fav && !almost) continue;
    if (almost && missing.length === 1) addNeed(missing[0], name);
    else if (fav) missing.forEach((ingredient) => addNeed(ingredient, name));
  }

  for (const [key, need] of needs) {
    items.push({
      key,
      kind: "ingredient",
      name: need.label,
      reason: need.drinks.length === 1 ? `Unlocks ${need.drinks[0]}` : `Needed for ${need.drinks.join(", ")}`,
      image_url: "",
      got: false
    });
  }

  const rank = (item: RestockItem) => item.kind === "ingredient" ? 1 : 0;
  items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return items.map((item) => ({ ...item, got: got.has(item.key) }));
}

export function restockSummary(items: RestockItem[]): { total: number; open: number } {
  return { total: items.length, open: items.filter((item) => !item.got).length };
}
