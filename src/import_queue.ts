import { db } from "./db.js";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import { localizeImage } from "./images.js";
import { inferImportKind } from "./lookup.js";
import { identifyByBarcode } from "./ingestion/bottle-orchestrator.js";
import {
  isImportKind,
  isLookupSource,
  isMissReason,
  isReadyLookup,
  type ImportKind,
  type ImportQueueRow,
  type ImportRowStatus,
  type ImportTable,
  type LookupResult,
  type LookupSource,
  type LookupVariants,
  type MissReason
} from "./lookup-shared.js";
import { importRowHasName, importTableFor, normalizeImportItem, normalizeImportUpc } from "./import_batch.js";
import { maybeEnqueueMetadataEnrichment } from "./ingestion/jobs/index.js";

export const MAX_IMPORT_ROWS = 1500;
const FWGS_BATCH_DELAY_MS = Number(process.env.FWGS_DELAY_MS ?? 400);

export function ensureImportQueueTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upc TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'spirits',
      table_name TEXT NOT NULL DEFAULT 'spirits',
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'not_found',
      product_json TEXT NOT NULL DEFAULT '{}',
      message TEXT NOT NULL DEFAULT '',
      variants_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_import_queue_status ON import_queue(status, kind);
    CREATE INDEX IF NOT EXISTS idx_import_queue_upc ON import_queue(upc);
  `);
}

ensureImportQueueTable();

type QueueDbRow = {
  id: number;
  upc: string;
  kind: string;
  table_name: string;
  status: string;
  reason: string | null;
  source: string;
  product_json: string;
  message: string;
  variants_json: string | null;
  created_at: string;
  updated_at: string;
};

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Stored product blobs must never crash the review screen.
  }
  return {};
}

function parseVariants(raw: string | null): LookupVariants | null {
  const value = parseJsonObject(raw);
  const upcA = String(value.upcA ?? "").trim();
  const ean13 = String(value.ean13 ?? "").trim();
  if (!upcA && !ean13) return null;
  return { upcA, ean13 };
}

function asKind(value: string, fallback: ImportKind = "spirits"): ImportKind {
  return isImportKind(value) ? value : fallback;
}

function asTable(value: string, kind: ImportKind): ImportTable {
  if (value === "spirits" || value === "wines" || value === "packaged_beer") return value;
  if (kind === "beer") return "packaged_beer";
  if (kind === "wines") return "wines";
  return "spirits";
}

function asStatus(value: string): ImportRowStatus {
  if (value === "pending" || value === "ready" || value === "needs_review" || value === "skipped") return value;
  return "needs_review";
}

function asSource(value: string): LookupSource {
  return isLookupSource(value) ? value : "not_found";
}

function asReason(value: string | null): MissReason | null {
  return value && isMissReason(value) ? value : null;
}

function mapRow(row: QueueDbRow): ImportQueueRow {
  const kind = asKind(row.kind);
  return {
    id: row.id,
    upc: row.upc,
    kind,
    table: asTable(row.table_name, kind),
    status: asStatus(row.status),
    reason: asReason(row.reason),
    source: asSource(row.source),
    product: parseJsonObject(row.product_json),
    message: row.message ?? "",
    variants: parseVariants(row.variants_json),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function kindFromInput(row: Record<string, unknown>): ImportKind | undefined {
  const declared = String(row.kind ?? "").trim().toLowerCase();
  if (isImportKind(declared)) return declared;
  if (declared === "wine") return "wines";
  if (declared === "mixer" || declared === "bitters") return "mixers";
  if (declared === "packaged_beer") return "beer";
  const table = String(row.table ?? row.module ?? "").trim().toLowerCase();
  if (table === "packaged_beer") return "beer";
  if (table === "wines") return "wines";
  if (table === "mixers") return "mixers";
  if (importRowHasName(row)) return inferImportKind(row);
  return undefined;
}

export function lookupToQueueFields(result: LookupResult): {
  upc: string;
  kind: ImportKind;
  table: ImportTable;
  status: ImportRowStatus;
  reason: MissReason | null;
  source: LookupSource;
  product: Record<string, unknown>;
  message: string;
  variants: LookupVariants | null;
} {
  const kind = result.kind ?? inferImportKind(result.product);
  const table = result.table ?? (kind === "beer" ? "packaged_beer" : kind === "wines" ? "wines" : "spirits");
  const ready = isReadyLookup(result);
  return {
    upc: result.upc,
    kind,
    table,
    status: ready ? "ready" : "needs_review",
    reason: result.reason ?? (ready ? null : "no_catalog"),
    source: result.source,
    product: result.product ?? { upc: result.upc },
    message: result.message ?? "",
    variants: result.variants ?? null
  };
}

function writeQueueRow(
  id: number | null,
  fields: ReturnType<typeof lookupToQueueFields>,
  statusOverride?: ImportRowStatus
) {
  const status = statusOverride ?? fields.status;
  const variantsJson = fields.variants ? JSON.stringify(fields.variants) : null;
  const productJson = JSON.stringify(fields.product);
  if (id != null) {
    db.prepare(`
      UPDATE import_queue SET
        upc=?, kind=?, table_name=?, status=?, reason=?, source=?, product_json=?, message=?, variants_json=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      fields.upc, fields.kind, fields.table, status, fields.reason, fields.source,
      productJson, fields.message, variantsJson, id
    );
    return id;
  }
  const existing = db.prepare(
    "SELECT id FROM import_queue WHERE upc=? AND status IN ('pending','needs_review','ready') LIMIT 1"
  ).get(fields.upc) as { id: number } | undefined;
  if (existing?.id) {
    return writeQueueRow(existing.id, fields, status);
  }
  const result = db.prepare(`
    INSERT INTO import_queue (upc, kind, table_name, status, reason, source, product_json, message, variants_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.upc, fields.kind, fields.table, status, fields.reason, fields.source,
    productJson, fields.message, variantsJson
  );
  return Number(result.lastInsertRowid);
}

export function getImportQueueRow(id: number): ImportQueueRow | null {
  const row = db.prepare("SELECT * FROM import_queue WHERE id=?").get(id) as QueueDbRow | undefined;
  return row ? mapRow(row) : null;
}

export function listImportQueue(filters?: { status?: ImportRowStatus | "all"; kind?: ImportKind | "all"; reason?: MissReason | "all" }): ImportQueueRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters?.status && filters.status !== "all") {
    clauses.push("status=?");
    params.push(filters.status);
  }
  if (filters?.kind && filters.kind !== "all") {
    clauses.push("kind=?");
    params.push(filters.kind);
  }
  if (filters?.reason && filters.reason !== "all") {
    clauses.push("reason=?");
    params.push(filters.reason);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM import_queue ${where} ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'needs_review' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END, id DESC`).all(...params) as QueueDbRow[];
  return rows.map(mapRow);
}

export function importQueueCounts() {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM import_queue GROUP BY status").all() as Array<{ status: string; n: number }>;
  const counts = { pending: 0, ready: 0, needs_review: 0, skipped: 0, total: 0 };
  for (const row of rows) {
    const status = asStatus(row.status);
    counts[status] += Number(row.n);
    counts.total += Number(row.n);
  }
  return counts;
}

export function queueLookupResult(result: LookupResult, id?: number) {
  const fields = lookupToQueueFields(result);
  const nextId = writeQueueRow(id ?? null, fields);
  return getImportQueueRow(nextId)!;
}

export function queuePendingUpc(rawUpc: string, kind?: ImportKind) {
  const upc = normalizeImportUpc(rawUpc) || String(rawUpc).trim();
  if (!upc) return null;
  const fields = lookupToQueueFields({
    source: "not_found",
    upc,
    kind,
    table: kind === "beer" ? "packaged_beer" : kind === "wines" ? "wines" : "spirits",
    product: { upc, name: "" },
    reason: "no_catalog",
    message: ""
  });
  const id = writeQueueRow(null, fields, "pending");
  return getImportQueueRow(id)!;
}

export function skipImportRow(id: number) {
  db.prepare("UPDATE import_queue SET status='skipped', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  return getImportQueueRow(id);
}

export function applyLabelToImportRow(id: number, product: Record<string, unknown>, upc?: string) {
  const existing = getImportQueueRow(id);
  if (!existing) return null;
  const merged = { ...existing.product, ...product, upc: upc || String(product.upc ?? existing.upc) };
  const result: LookupResult = {
    source: "label",
    upc: String(merged.upc ?? existing.upc),
    table: existing.table,
    kind: inferImportKind(merged, existing.kind),
    product: merged,
    variants: existing.variants ?? undefined
  };
  if (!isReadyLookup(result)) {
    result.reason = "no_catalog";
    result.message = "Could not read a name from that label.";
    result.source = "not_found";
  }
  return queueLookupResult(result, id);
}

export type QueueSeedRow = {
  upc: string;
  kind?: ImportKind;
  named?: Record<string, unknown>;
};

export function seedImportQueue(rows: unknown[]): { queued: number; skipped: number } {
  let queued = 0;
  let skipped = 0;
  const insert = db.transaction((items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        skipped += 1;
        continue;
      }
      const row = item as Record<string, unknown>;
      const upc = normalizeImportUpc(row.upc ?? row.barcode ?? row.code ?? row.ean);
      const kind = kindFromInput(row);
      if (importRowHasName(row)) {
        const table = importTableFor({ ...row, table: row.table ?? (kind === "beer" ? "packaged_beer" : kind === "wines" ? "wines" : "spirits") });
        const fields = lookupToQueueFields({
          source: "cache",
          upc: upc || String(row.upc ?? ""),
          table,
          kind: kind ?? inferImportKind(row),
          product: { ...row, upc, table }
        });
        writeQueueRow(null, fields, "ready");
        queued += 1;
        continue;
      }
      if (!upc && !String(row.upc ?? "").trim()) {
        skipped += 1;
        continue;
      }
      queuePendingUpc(upc || String(row.upc ?? ""), kind);
      queued += 1;
    }
  });
  insert(rows);
  return { queued, skipped };
}

let importJob: Promise<void> | null = null;

async function processPendingImports() {
  const pending = db.prepare("SELECT * FROM import_queue WHERE status='pending' ORDER BY id").all() as QueueDbRow[];
  for (const row of pending) {
    const mapped = mapRow(row);
    const result = await identifyByBarcode(mapped.upc, {
      mode: "batch",
      kind: mapped.kind
    });
    queueLookupResult(result, mapped.id);
    if (FWGS_BATCH_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, FWGS_BATCH_DELAY_MS));
    }
  }
}

export function startImportJob(): boolean {
  if (importJob) return false;
  importJob = processPendingImports().finally(() => {
    importJob = null;
  });
  return true;
}

export function importJobRunning() {
  return importJob != null;
}

export type CommitResult = {
  imported: number;
  cached: number;
  skipped: number;
  items: Array<{ table: string; id: number; name: string }>;
  rejected: Array<{ name: string; reason: string }>;
};

const TABLE_FIELDS: Record<ImportTable, string[]> = {
  spirits: ["name","brand","category","sub_category","abv","volume_ml","fill_level","purchase_date","opened_date","shelf_location","upc","notes","image_url","stock_count","tasting_notes","flavors","tags","base_ingredient","blocked_from_ordering"],
  packaged_beer: ["brewery","name","style","count","pack_date","abv","upc","image_url","notes","tasting_notes","flavors","tags","base_ingredient","vessel"],
  wines: ["producer","name","varietal","vintage","type","style","region","sweetness","body","bottle_count","drink_by_date","pairings","notes","upc","image_url","tasting_notes","flavors","tags","base_ingredient","blocked_from_ordering"]
};

export async function commitReadyImportRows(ids?: number[]): Promise<CommitResult> {
  const placeholders = ids?.length ? `AND id IN (${ids.map(() => "?").join(",")})` : "";
  const rows = db.prepare(`SELECT * FROM import_queue WHERE status='ready' ${placeholders} ORDER BY id`).all(...(ids ?? [])) as QueueDbRow[];
  const imported: Array<{ table: string; id: number; name: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let cached = 0;

  for (const raw of rows) {
    const row = mapRow(raw);
    const normalized = normalizeImportItem({ ...row.product, upc: row.upc, table: row.table });
    if (!normalized) {
      skipped.push({ name: row.upc || `Row ${row.id}`, reason: "No name to import" });
      continue;
    }
    const { table, values, cache } = normalized;
    const name = String(values.name);
    try {
      if (cache.upc) {
        const clash = db.prepare(`SELECT id FROM ${table} WHERE upc = ? AND upc != '' LIMIT 1`).get(cache.upc) as { id?: number } | undefined;
        if (clash?.id) {
          if (saveBarcodeCacheEntry(cache)) cached += 1;
          db.prepare("DELETE FROM import_queue WHERE id=?").run(row.id);
          skipped.push({ name, reason: "Already in the vault under that barcode" });
          continue;
        }
      }
      if (typeof values.image_url === "string" && values.image_url) {
        values.image_url = await localizeImage(values.image_url) ?? values.image_url;
      }
      const fields = TABLE_FIELDS[table].filter((field) => values[field] !== undefined && values[field] !== null);
      const write = db.transaction(() => {
        const result = db.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`)
          .run(...fields.map((field) => values[field] as never));
        if (saveBarcodeCacheEntry({ ...cache, image_url: String(values.image_url ?? cache.image_url) })) cached += 1;
        db.prepare("DELETE FROM import_queue WHERE id=?").run(row.id);
        return Number(result.lastInsertRowid);
      });
      const id = write();
      imported.push({ table, id, name });
      try {
        const saved = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown>;
        maybeEnqueueMetadataEnrichment({ entityType: table, entityId: id, row: saved });
      } catch {
        // Bottle is saved; queue failure must not roll back the import commit.
      }
    } catch {
      skipped.push({ name, reason: "Could not be written to the vault" });
    }
  }

  return { imported: imported.length, cached, skipped: skipped.length, items: imported, rejected: skipped };
}

export function clearSkippedImportRows() {
  const result = db.prepare("DELETE FROM import_queue WHERE status='skipped'").run();
  return result.changes;
}
