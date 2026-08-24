import { db } from "./db.js";
import {
  fillStopLabel,
  isSpiritEmpty,
  nearestFillStop,
  openNextSpirit,
  packagedCount,
  packagedStockLabel,
  spiritStockLabel,
  wineDrinkByOverdue
} from "./catalog.js";
import { spiritOnShelf, stripMeasure } from "./cocktails.js";
import type { RestockItem, RestockKind, RestockThresholds, WantedLabel, WantedRow } from "./restock-shared.js";
import { DEFAULT_RESTOCK_THRESHOLDS, MAX_WANTED_NAME, MAX_WANTED_NOTE } from "./restock-shared.js";

export {
  type RestockKind,
  type WantedLabel,
  type WantedRow,
  type RestockThresholds,
  type RestockItem,
  MAX_WANTED_NAME,
  MAX_WANTED_NOTE,
  DEFAULT_RESTOCK_THRESHOLDS,
  RESTOCK_PACKAGED_STOPS,
  RESTOCK_WINE_STOPS,
  RESTOCK_SPIRIT_STOPS,
  parseRestockThresholds,
  formatRestockShare
} from "./restock-shared.js";

db.exec(`
CREATE TABLE IF NOT EXISTS restock_got (
  key TEXT PRIMARY KEY,
  got INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS restock_wanted (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT 'bottle',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function wantedLabel(value: unknown): WantedLabel {
  return String(value ?? "").trim().toLowerCase() === "mixer" ? "mixer" : "bottle";
}

export function listWanted(): WantedRow[] {
  return db.prepare(
    "SELECT id, name, note, label, created_at FROM restock_wanted ORDER BY id DESC"
  ).all() as WantedRow[];
}

export function createWanted(input: { name?: string; note?: string; label?: string }): WantedRow {
  const name = text(input.name).replace(/\s+/g, " ");
  const note = text(input.note).replace(/\s+/g, " ");
  const label = wantedLabel(input.label);
  if (!name) throw new Error("Add a bottle or mixer name");
  if (name.length > MAX_WANTED_NAME) throw new Error(`Name must be ${MAX_WANTED_NAME} characters or fewer`);
  if (note.length > MAX_WANTED_NOTE) throw new Error(`Note must be ${MAX_WANTED_NOTE} characters or fewer`);
  const existing = db.prepare("SELECT id FROM restock_wanted WHERE lower(name)=lower(?)").get(name) as { id: number } | undefined;
  if (existing) throw new Error("That's already on the wanted list");
  const result = db.prepare("INSERT INTO restock_wanted(name,note,label) VALUES(?,?,?)").run(name, note, label);
  return db.prepare("SELECT id, name, note, label, created_at FROM restock_wanted WHERE id=?").get(result.lastInsertRowid) as WantedRow;
}

export function deleteWanted(id: number): boolean {
  const n = Math.floor(Number(id));
  if (!Number.isFinite(n) || n <= 0) return false;
  db.prepare("DELETE FROM restock_got WHERE key=?").run(`wanted:${n}`);
  return db.prepare("DELETE FROM restock_wanted WHERE id=?").run(n).changes > 0;
}

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
  wanted?: Array<Pick<WantedRow, "id" | "name" | "note" | "label">>;
  got?: Iterable<string>;
  thresholds?: RestockThresholds;
}): RestockItem[] {
  const got = new Set(input.got ?? []);
  const thresholds = input.thresholds ?? DEFAULT_RESTOCK_THRESHOLDS;
  const items: RestockItem[] = [];

  for (const item of input.wanted ?? []) {
    const note = text(item.note);
    const label = wantedLabel(item.label);
    items.push({
      key: `wanted:${itemId(item.id)}`,
      kind: "wanted",
      id: itemId(item.id),
      name: text(item.name) || "Untitled",
      reason: note || (label === "mixer" ? "Wanted mixer" : "Wanted for the vault"),
      image_url: "",
      got: false
    });
  }

  for (const item of input.spirits ?? []) {
    if (openNextSpirit(item)) continue;
    const fill = nearestFillStop(item.fill_level);
    const empty = isSpiritEmpty(item);
    const low = spiritOnShelf(item) && fill <= thresholds.spiritFill;
    if (!empty && !low) continue;
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
    const overdue = wineDrinkByOverdue(item);
    if (count > 0 && count < thresholds.wineBelow) {
      items.push({
        key: `wines:${itemId(item.id)}`,
        kind: "wines",
        module: "wines",
        id: itemId(item.id),
        name: bottleName(item, "producer"),
        reason: count === 1 ? "Last bottle" : `${count} left`,
        image_url: text(item.image_url),
        got: false
      });
    } else if (overdue && count > 0) {
      items.push({
        key: `wines-drinkby:${itemId(item.id)}`,
        kind: "wines",
        module: "wines",
        id: itemId(item.id),
        name: bottleName(item, "producer"),
        reason: `Drink by ${String(item.drink_by_date ?? "").slice(0, 10)}`,
        image_url: text(item.image_url),
        got: false
      });
    }
  }

  for (const item of input.packaged ?? []) {
    const count = packagedCount(item.count);
    if (count >= thresholds.packagedBelow) continue;
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

  const rank = (item: RestockItem) => item.kind === "wanted" ? 0 : item.kind === "ingredient" ? 2 : 1;
  items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return items.map((item) => ({ ...item, got: got.has(item.key) }));
}

export function restockSummary(items: RestockItem[]): { total: number; open: number } {
  return { total: items.length, open: items.filter((item) => !item.got).length };
}
