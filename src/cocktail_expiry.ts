import { db } from "./db.js";

const GUEST_SAVE_MS = 24 * 60 * 60 * 1000;

/** UTC `YYYY-MM-DD HH:MM:SS`, matching SQLite `datetime('now')` so string compares stay ordered. */
export function sqliteUtc(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function guestCocktailExpiresAt(now = new Date()): string {
  return sqliteUtc(new Date(now.getTime() + GUEST_SAVE_MS));
}

/** Drops expired Guest rows only. `expires_at IS NULL` is permanent and is never deleted. */
export function purgeExpiredCocktails(now = sqliteUtc()): number {
  return db.prepare(
    "DELETE FROM cocktails WHERE expires_at IS NOT NULL AND expires_at <= ?"
  ).run(now).changes;
}

export function listActiveCocktails(order: "name" | "id" = "name"): Array<Record<string, unknown>> {
  const now = sqliteUtc();
  purgeExpiredCocktails(now);
  const orderBy = order === "id" ? "id DESC" : "name";
  return db.prepare(
    `SELECT * FROM cocktails WHERE expires_at IS NULL OR expires_at > ? ORDER BY ${orderBy}`
  ).all(now) as Array<Record<string, unknown>>;
}
