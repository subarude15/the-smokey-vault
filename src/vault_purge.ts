import { db } from "./db.js";
import { deleteVotesForItem } from "./votes.js";
import { deleteReviewsForItem } from "./reviews.js";
import { deleteDailyVotesForItem } from "./speakeasy.js";

/** Scanned shelf modules — not taps (fixed slots), brews, or cocktails. */
export const PURGE_TABLES = ["spirits", "packaged_beer", "wines"] as const;
export type PurgeTable = (typeof PURGE_TABLES)[number];

export const PURGE_WINDOWS = ["1h", "6h", "24h", "all"] as const;
export type PurgeWindow = (typeof PURGE_WINDOWS)[number];

export const PURGE_CONFIRM = "DELETE";

export type PurgeCounts = Record<PurgeTable, number> & { total: number };

const WINDOW_MS: Record<Exclude<PurgeWindow, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000
};

export function isPurgeWindow(value: unknown): value is PurgeWindow {
  return typeof value === "string" && (PURGE_WINDOWS as readonly string[]).includes(value);
}

/** SQLite CURRENT_TIMESTAMP style: `YYYY-MM-DD HH:MM:SS` in UTC. */
export function sqliteUtc(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function cutoffForWindow(window: PurgeWindow, now = new Date()): string | null {
  if (window === "all") return null;
  return sqliteUtc(new Date(now.getTime() - WINDOW_MS[window]));
}

/** Normalize either SQLite or ISO timestamps so lexicographic/datetime compares work. */
const CREATED_EXPR = "datetime(replace(substr(created_at, 1, 19), 'T', ' '))";

function selectIds(table: PurgeTable, cutoff: string | null): number[] {
  const sql = cutoff
    ? `SELECT id FROM ${table} WHERE ${CREATED_EXPR} >= datetime(?)`
    : `SELECT id FROM ${table}`;
  const rows = (cutoff
    ? db.prepare(sql).all(cutoff)
    : db.prepare(sql).all()) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id));
}

export function previewVaultPurge(window: PurgeWindow, now = new Date()): PurgeCounts {
  const cutoff = cutoffForWindow(window, now);
  const counts = { spirits: 0, packaged_beer: 0, wines: 0, total: 0 } as PurgeCounts;
  for (const table of PURGE_TABLES) {
    const n = selectIds(table, cutoff).length;
    counts[table] = n;
    counts.total += n;
  }
  return counts;
}

export function emptyVault(window: PurgeWindow, confirm: string, now = new Date()): PurgeCounts {
  if (confirm !== PURGE_CONFIRM) {
    throw new Error(`Type ${PURGE_CONFIRM} to confirm`);
  }
  if (!isPurgeWindow(window)) {
    throw new Error("Unknown purge window");
  }

  const cutoff = cutoffForWindow(window, now);
  const counts = { spirits: 0, packaged_beer: 0, wines: 0, total: 0 } as PurgeCounts;

  const run = db.transaction(() => {
    for (const table of PURGE_TABLES) {
      const ids = selectIds(table, cutoff);
      for (const id of ids) {
        deleteReviewsForItem(table, id);
        deleteVotesForItem(table, id);
        deleteDailyVotesForItem(table, id);
        db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      }
      counts[table] = ids.length;
      counts.total += ids.length;
    }
  });
  run();
  return counts;
}
