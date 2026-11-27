import { db } from "./db.js";
import { recordAdminAuditEvent } from "./ingestion/jobs/admin-audit.js";

export const RECOUNT_SHELF_TABLES = [
  "spirits",
  "wines",
  "packaged_beer"
] as const;

export type RecountShelfTable = (typeof RECOUNT_SHELF_TABLES)[number];

export type ShelfSectionRecountStats = {
  totalRows: number;
  inStockRows: number;
  zeroStockRows: number;
};

export type ShelfRecountPreview = {
  sections: Record<RecountShelfTable, ShelfSectionRecountStats>;
  totals: ShelfSectionRecountStats;
};

export type ShelfRecountZeroResult = {
  tables: RecountShelfTable[];
  updatedRows: Record<RecountShelfTable, number>;
  totalUpdated: number;
  preview: ShelfRecountPreview;
};

export function isRecountShelfTable(value: unknown): value is RecountShelfTable {
  return typeof value === "string" && (RECOUNT_SHELF_TABLES as readonly string[]).includes(value);
}

export function normalizeRecountTables(input: unknown): RecountShelfTable[] {
  if (!Array.isArray(input)) return [];
  const selected = new Set<RecountShelfTable>();
  for (const entry of input) {
    if (isRecountShelfTable(entry)) selected.add(entry);
  }
  return RECOUNT_SHELF_TABLES.filter((table) => selected.has(table));
}

function sectionStats(table: RecountShelfTable): ShelfSectionRecountStats {
  const totalRows = Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  );
  let zeroStockRows = 0;
  if (table === "spirits") {
    zeroStockRows = Number(
      (
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM spirits
          WHERE stock_count IS NOT NULL
            AND trim(CAST(stock_count AS TEXT)) <> ''
            AND CAST(stock_count AS INTEGER) <= 0
        `).get() as { count: number }
      ).count
    );
  } else if (table === "wines") {
    zeroStockRows = Number(
      (
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM wines
          WHERE COALESCE(CAST(bottle_count AS INTEGER), 0) <= 0
        `).get() as { count: number }
      ).count
    );
  } else {
    zeroStockRows = Number(
      (
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM packaged_beer
          WHERE COALESCE(CAST(count AS INTEGER), 0) <= 0
        `).get() as { count: number }
      ).count
    );
  }
  const inStockRows = Math.max(0, totalRows - zeroStockRows);
  return { totalRows, inStockRows, zeroStockRows };
}

/**
 * Read-only summary of current shelf records vs. non-zero stock rows.
 */
export function previewShelfRecount(): ShelfRecountPreview {
  const sections: Record<RecountShelfTable, ShelfSectionRecountStats> = {
    spirits: sectionStats("spirits"),
    wines: sectionStats("wines"),
    packaged_beer: sectionStats("packaged_beer")
  };
  const totals: ShelfSectionRecountStats = {
    totalRows: sections.spirits.totalRows + sections.wines.totalRows + sections.packaged_beer.totalRows,
    inStockRows: sections.spirits.inStockRows + sections.wines.inStockRows + sections.packaged_beer.inStockRows,
    zeroStockRows: sections.spirits.zeroStockRows + sections.wines.zeroStockRows + sections.packaged_beer.zeroStockRows
  };
  return { sections, totals };
}

/**
 * Zeroes shelf quantities on the selected bottle/can sections while preserving
 * every product row, UPC, tasting note, photo, enrichment record, review, vote,
 * and lookup cache entry. Does not touch taps or homebrew batches.
 */
export function zeroShelfCountsForRecount(tablesInput: unknown): ShelfRecountZeroResult {
  const tables = normalizeRecountTables(tablesInput);
  if (!tables.length) {
    throw new Error("Select at least one shelf section to zero");
  }

  const updatedRows: Record<RecountShelfTable, number> = {
    spirits: 0,
    wines: 0,
    packaged_beer: 0
  };

  db.transaction(() => {
    for (const table of tables) {
      if (table === "spirits") {
        updatedRows.spirits = db.prepare(`
          UPDATE spirits
          SET stock_count = 0,
              fill_level = 0,
              updated_at = CURRENT_TIMESTAMP
          WHERE stock_count IS NULL
             OR trim(CAST(stock_count AS TEXT)) = ''
             OR CAST(stock_count AS INTEGER) <> 0
             OR COALESCE(CAST(fill_level AS REAL), 0) <> 0
        `).run().changes;
      } else if (table === "wines") {
        updatedRows.wines = db.prepare(`
          UPDATE wines
          SET bottle_count = 0,
              updated_at = CURRENT_TIMESTAMP
          WHERE bottle_count IS NULL
             OR trim(CAST(bottle_count AS TEXT)) = ''
             OR CAST(bottle_count AS INTEGER) <> 0
        `).run().changes;
      } else if (table === "packaged_beer") {
        updatedRows.packaged_beer = db.prepare(`
          UPDATE packaged_beer
          SET count = 0,
              updated_at = CURRENT_TIMESTAMP
          WHERE count IS NULL
             OR trim(CAST(count AS TEXT)) = ''
             OR CAST(count AS INTEGER) <> 0
        `).run().changes;
      }
    }

    recordAdminAuditEvent("inventory_counts_zeroed", {
      tables,
      updatedRows
    });
  })();

  const totalUpdated = updatedRows.spirits + updatedRows.wines + updatedRows.packaged_beer;
  return {
    tables,
    updatedRows,
    totalUpdated,
    preview: previewShelfRecount()
  };
}
