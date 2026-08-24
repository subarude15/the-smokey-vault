import { db } from "./db.js";
import { isTapEmpty, packagedCount, tapTitle } from "./catalog.js";

export type Pour = {
  id: number;
  module: string;
  item_id: number;
  name: string;
  amount: string;
  guest_name: string;
  created_at: string;
};

db.exec(`
CREATE TABLE IF NOT EXISTS pours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  item_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '',
  guest_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS pours_created ON pours(created_at DESC);
`);

export function nightStart(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(4, 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return start;
}

function clip(value: unknown, max: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function recordPour(input: {
  module: string;
  item_id?: number;
  name: string;
  amount?: string;
  guest_name?: string;
}): Pour {
  const name = clip(input.name, 120) || "Untitled";
  const result = db.prepare(
    "INSERT INTO pours(module,item_id,name,amount,guest_name,created_at) VALUES(?,?,?,?,?,?)"
  ).run(
    clip(input.module, 40) || "spirits",
    Math.max(0, Math.floor(Number(input.item_id) || 0)),
    name,
    clip(input.amount, 40),
    clip(input.guest_name, 40),
    new Date().toISOString()
  );
  return db.prepare(
    "SELECT id, module, item_id, name, amount, guest_name, created_at FROM pours WHERE id=?"
  ).get(result.lastInsertRowid) as Pour;
}

export function listTonightPours(now = new Date()): Pour[] {
  return db.prepare(
    "SELECT id, module, item_id, name, amount, guest_name, created_at FROM pours WHERE created_at >= ? ORDER BY id DESC LIMIT 40"
  ).all(nightStart(now).toISOString()) as Pour[];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bottleName(row: Record<string, unknown>, table: string): string {
  if (table === "taps") return tapTitle(row);
  const name = String(row.name ?? row.batch_name ?? "").trim();
  const maker = String(row.brand ?? row.producer ?? row.brewery ?? row.maker ?? "").trim();
  if (name && maker && !name.toLowerCase().includes(maker.toLowerCase())) return `${maker} ${name}`;
  return name || maker || "Untitled";
}

export function maybeInventoryPour(
  table: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): Pour | null {
  if (!before || !after) return null;
  const id = Math.floor(Number(after.id ?? before.id) || 0);
  if (table === "spirits" && num(after.fill_level) < num(before.fill_level)) {
    return recordPour({ module: table, item_id: id, name: bottleName(after, table), amount: "Pour" });
  }
  if (table === "taps" && !isTapEmpty(after) && num(after.remaining_l) < num(before.remaining_l)) {
    return recordPour({ module: table, item_id: id, name: bottleName(after, table), amount: "Pint" });
  }
  if (table === "wines" && num(after.bottle_count) < num(before.bottle_count)) {
    return recordPour({ module: table, item_id: id, name: bottleName(after, table), amount: "Bottle" });
  }
  if (table === "packaged_beer" && packagedCount(after.count) < packagedCount(before.count)) {
    return recordPour({ module: table, item_id: id, name: bottleName(after, table), amount: "One" });
  }
  return null;
}
