/**
 * Separate SQLite store for the Iowa Liquor Products catalog.
 * Kept out of the canonical inventory DB.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { preferIowaRow } from "./iowa-category.js";

export const DEFAULT_IOWA_DB_PATH = resolve("data/iowa-liquor.sqlite");

export type IowaProductRow = {
  item_no: string;
  category_name: string;
  name: string;
  vendor_no: string | null;
  vendor_name: string | null;
  bottle_volume_ml: number | null;
  age: number | null;
  proof: number | null;
  abv: number | null;
  list_on: string | null;
  report_as_of: string | null;
  upc: string | null;
  raw_upc: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS iowa_liquor_products (
  item_no TEXT NOT NULL,
  category_name TEXT NOT NULL,
  name TEXT NOT NULL,
  vendor_no TEXT,
  vendor_name TEXT,
  bottle_volume_ml INTEGER,
  age REAL,
  proof REAL,
  abv REAL,
  list_on TEXT,
  report_as_of TEXT,
  upc TEXT,
  raw_upc TEXT,
  PRIMARY KEY (item_no, category_name)
);
CREATE INDEX IF NOT EXISTS idx_iowa_upc ON iowa_liquor_products(upc);
CREATE INDEX IF NOT EXISTS idx_iowa_item_no ON iowa_liquor_products(item_no);
`;

let iowaDb: Database.Database | null = null;
let iowaDbPath: string | null = null;

export function getIowaDbPath(): string {
  return process.env.IOWA_LIQUOR_DB_PATH?.trim() || DEFAULT_IOWA_DB_PATH;
}

export function openIowaDb(path = getIowaDbPath()): Database.Database {
  const resolved = resolve(path);
  if (iowaDb && iowaDbPath === resolved) return iowaDb;
  if (iowaDb) {
    iowaDb.close();
    iowaDb = null;
    iowaDbPath = null;
  }
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  iowaDb = db;
  iowaDbPath = resolved;
  return db;
}

/** Test helper — close the shared connection so the next open can retarget. */
export function resetIowaDbConnection(): void {
  if (iowaDb) {
    iowaDb.close();
    iowaDb = null;
    iowaDbPath = null;
  }
}

export function replaceIowaProducts(rows: IowaProductRow[], path = getIowaDbPath()): number {
  const db = openIowaDb(path);
  const clear = db.prepare("DELETE FROM iowa_liquor_products");
  const insert = db.prepare(`
    INSERT INTO iowa_liquor_products (
      item_no, category_name, name, vendor_no, vendor_name,
      bottle_volume_ml, age, proof, abv, list_on, report_as_of, upc, raw_upc
    ) VALUES (
      @item_no, @category_name, @name, @vendor_no, @vendor_name,
      @bottle_volume_ml, @age, @proof, @abv, @list_on, @report_as_of, @upc, @raw_upc
    )
  `);
  const tx = db.transaction((batch: IowaProductRow[]) => {
    clear.run();
    for (const row of batch) insert.run(row);
    return batch.length;
  });
  return tx(rows);
}

function mapRow(row: Record<string, unknown>): IowaProductRow {
  return {
    item_no: String(row.item_no ?? ""),
    category_name: String(row.category_name ?? ""),
    name: String(row.name ?? ""),
    vendor_no: row.vendor_no == null ? null : String(row.vendor_no),
    vendor_name: row.vendor_name == null ? null : String(row.vendor_name),
    bottle_volume_ml: row.bottle_volume_ml == null ? null : Number(row.bottle_volume_ml),
    age: row.age == null ? null : Number(row.age),
    proof: row.proof == null ? null : Number(row.proof),
    abv: row.abv == null ? null : Number(row.abv),
    list_on: row.list_on == null ? null : String(row.list_on),
    report_as_of: row.report_as_of == null ? null : String(row.report_as_of),
    upc: row.upc == null ? null : String(row.upc),
    raw_upc: row.raw_upc == null ? null : String(row.raw_upc)
  };
}

export function findIowaRowsByUpc(upc: string, path = getIowaDbPath()): IowaProductRow[] {
  if (!upc) return [];
  const db = openIowaDb(path);
  const rows = db
    .prepare(
      `SELECT * FROM iowa_liquor_products
       WHERE upc = ? OR upc = ? OR upc = ?`
    )
    .all(upc, upc.replace(/^0/, ""), upc.padStart(12, "0").slice(-12)) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function findIowaRowsByItemNo(itemNo: string, path = getIowaDbPath()): IowaProductRow[] {
  if (!itemNo) return [];
  const db = openIowaDb(path);
  const rows = db
    .prepare(`SELECT * FROM iowa_liquor_products WHERE item_no = ?`)
    .all(String(itemNo)) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function resolveIowaByUpc(upc: string, path = getIowaDbPath()): IowaProductRow | null {
  const rows = findIowaRowsByUpc(upc, path);
  if (!rows.length) return null;
  return preferIowaRow(rows);
}

export function resolveIowaByItemNo(itemNo: string, path = getIowaDbPath()): IowaProductRow | null {
  const rows = findIowaRowsByItemNo(itemNo, path);
  if (!rows.length) return null;
  return preferIowaRow(rows);
}

export function countIowaProducts(path = getIowaDbPath()): number {
  const db = openIowaDb(path);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM iowa_liquor_products`).get() as { n: number };
  return Number(row?.n ?? 0);
}
