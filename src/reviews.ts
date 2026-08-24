import { db } from "./db.js";

export const REVIEW_TABLES = new Set(["spirits", "taps", "brews", "packaged_beer", "wines"]);
export const MAX_REVIEW_AUTHOR = 40;
export const MAX_REVIEW_BODY = 2000;

export type Review = {
  id: number;
  table_name: string;
  item_id: number;
  author: string;
  body: string;
  created_at: string;
};

db.exec(`
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS reviews_item ON reviews(table_name, item_id, created_at);
`);

export function itemExists(table: string, id: number) {
  if (!REVIEW_TABLES.has(table) || !Number.isInteger(id) || id < 1) return false;
  return Boolean(db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id));
}

export function listReviews(table: string, itemId: number): Review[] {
  return db.prepare(
    "SELECT id, table_name, item_id, author, body, created_at FROM reviews WHERE table_name=? AND item_id=? ORDER BY id DESC"
  ).all(table, itemId) as Review[];
}

export function createReview(table: string, itemId: number, author: string, body: string): Review {
  const name = author.trim().replace(/\s+/g, " ");
  const text = body.trim();
  if (!name) throw new Error("Add your name");
  if (name.length > MAX_REVIEW_AUTHOR) throw new Error(`Name must be ${MAX_REVIEW_AUTHOR} characters or fewer`);
  if (!text) throw new Error("Write a short review");
  if (text.length > MAX_REVIEW_BODY) throw new Error(`Review must be ${MAX_REVIEW_BODY} characters or fewer`);
  if (!itemExists(table, itemId)) throw new Error("Bottle not found");
  const result = db.prepare(
    "INSERT INTO reviews(table_name, item_id, author, body) VALUES(?, ?, ?, ?)"
  ).run(table, itemId, name, text);
  return db.prepare("SELECT id, table_name, item_id, author, body, created_at FROM reviews WHERE id=?").get(result.lastInsertRowid) as Review;
}

export function deleteReview(id: number) {
  const result = db.prepare("DELETE FROM reviews WHERE id=?").run(id);
  return result.changes > 0;
}

export function deleteReviewsForItem(table: string, itemId: number) {
  db.prepare("DELETE FROM reviews WHERE table_name=? AND item_id=?").run(table, itemId);
}
