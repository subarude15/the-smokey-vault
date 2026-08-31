/**
 * Admin shelf scan-session save pipeline.
 * Reuses identifyByBarcode + existing inventory write semantics.
 */
import { db } from "./db.js";
import {
  defaultSweetnessForWine,
  inferProductTable,
  inferWineFamilyAndStyle,
  packagedCount,
  preparePackagedWrite,
  prepareSpiritWrite,
  spiritFamilyFromLabel,
  spiritStock
} from "./catalog.js";
import {
  normalizeCanonicalAbv,
  normalizeCanonicalVolumeMl,
  stripPackageTokensFromName
} from "./canonical-normalize.js";
import { identifyByBarcode } from "./ingestion/bottle-orchestrator.js";
import {
  maybeEnqueueImageEnrichment,
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  recordLookupImageFallback
} from "./ingestion/jobs/index.js";
import { localizeImage } from "./images.js";
import { queueLookupResult } from "./import_queue.js";
import {
  IMPORT_KIND_LABELS,
  type ImportKind,
  type ImportTable,
  type LookupResult,
  lookupHasName,
  type MissReason
} from "./lookup-shared.js";

export const SCAN_DUPLICATE_COOLDOWN_MS = 2500;

export type ScanSessionAction = "added" | "updated" | "needs_review" | "duplicate" | "failed";

export type ScanSessionUndo = {
  table: ImportTable;
  id: number;
  action: "added" | "updated";
  snapshot: Record<string, unknown>;
};

export type ScanSessionSaveResult = {
  action: ScanSessionAction;
  upc: string;
  name: string;
  table: ImportTable | null;
  moduleLabel: string;
  message: string;
  quantityField?: string;
  quantityBefore?: number;
  quantityAfter?: number;
  enrichmentQueued: boolean;
  reason?: MissReason;
  undo?: ScanSessionUndo;
};

const SCAN_TABLES = new Set<ImportTable>(["spirits", "packaged_beer", "wines"]);

const MODULE_LABELS: Record<ImportTable, string> = {
  spirits: "Spirits",
  packaged_beer: "Packaged beer",
  wines: "Wine"
};

export function shouldSuppressDuplicateScan(
  upc: string,
  lastUpc: string | null,
  lastAtMs: number | null,
  nowMs = Date.now()
): boolean {
  if (!lastUpc || !lastAtMs) return false;
  if (lastUpc !== upc) return false;
  return nowMs - lastAtMs < SCAN_DUPLICATE_COOLDOWN_MS;
}

function lookupName(result: LookupResult): string {
  const product = result.product ?? {};
  return String(product.name ?? product.product_name ?? product.product_name_en ?? "").trim();
}

function textField(product: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = product[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function buildCreatePayload(result: LookupResult): { table: ImportTable; body: Record<string, unknown> } | null {
  const product = result.product ?? {};
  const categories = textField(product, "categories", "category");
  const productType = textField(product, "product_type");
  const rawAbv = product.abv ?? product.alcohol_100g ?? (product.nutriments as Record<string, unknown> | undefined)?.alcohol_100g;
  const abv = normalizeCanonicalAbv(
    typeof rawAbv === "number" ? rawAbv : Number.parseFloat(String(rawAbv ?? "")),
    { productType: productType || undefined }
  );
  const nameRaw = textField(product, "product_name", "product_name_en", "name");
  const name = stripPackageTokensFromName(nameRaw) || nameRaw;
  const brand = textField(product, "brands", "brand", "producer", "brewery");
  const upc = result.upc ?? textField(product, "code", "upc");
  const image = textField(product, "image_front_url", "image_url");
  const notes = textField(product, "notes");
  const volume = normalizeCanonicalVolumeMl(
    typeof product.volume_ml === "number"
      ? product.volume_ml
      : Number.parseFloat(String(product.volume_ml ?? ""))
  ) ?? 750;

  const table = result.table && SCAN_TABLES.has(result.table)
    ? result.table
    : inferProductTable({ name, category: categories, product_type: productType, brand });

  if (!SCAN_TABLES.has(table)) return null;

  if (table === "packaged_beer") {
    return {
      table,
      body: {
        name,
        brewery: brand,
        style: categories.split(",")[0] ?? "",
        abv: abv ?? 0,
        count: 1,
        vessel: /bottle/i.test(`${categories} ${productType} ${name}`) ? "Bottle" : "Can",
        upc,
        image_url: image
      }
    };
  }

  if (table === "wines") {
    const inferred = inferWineFamilyAndStyle(`${name} ${brand} ${categories} ${productType}`);
    return {
      table,
      body: {
        name,
        producer: brand,
        varietal: categories.split(",")[0] ?? "",
        type: inferred.type,
        style: inferred.style,
        sweetness: defaultSweetnessForWine(inferred.type, inferred.style),
        region: textField(product, "origin"),
        bottle_count: 1,
        notes,
        upc,
        image_url: image
      }
    };
  }

  const subHint = textField(product, "sub_category", "derived_subcategory");
  const mapped = spiritFamilyFromLabel(categories, subHint);
  return {
    table: "spirits",
    body: {
      name,
      brand,
      category: mapped.family || "",
      sub_category: mapped.type,
      abv,
      upc,
      image_url: image,
      stock_count: Number(product.stock_count ?? product.bottle_count ?? 1) || 1,
      fill_level: Number(product.fill_level ?? product.fill_level_percent ?? 100) || 100,
      volume_ml: volume,
      notes
    }
  };
}

function quantityFieldForTable(table: ImportTable): string {
  if (table === "spirits") return "stock_count";
  if (table === "wines") return "bottle_count";
  return "count";
}

function readQuantity(table: ImportTable, row: Record<string, unknown>): number {
  if (table === "spirits") {
    return row.stock_count == null || String(row.stock_count).trim() === "" ? 1 : spiritStock(row.stock_count);
  }
  if (table === "wines") {
    return row.bottle_count == null || String(row.bottle_count).trim() === "" ? 1 : spiritStock(row.bottle_count);
  }
  return packagedCount(row.count ?? 1);
}

function writeQuantity(table: ImportTable, row: Record<string, unknown>, next: number): Record<string, unknown> {
  if (table === "spirits") return prepareSpiritWrite({ ...row, stock_count: next });
  if (table === "wines") return { ...row, bottle_count: spiritStock(next) };
  return preparePackagedWrite({ ...row, count: next });
}

async function localizeBodyImage(body: Record<string, unknown>) {
  if (typeof body.image_url === "string" && body.image_url && !body.image_url.startsWith("/api/media/images/")) {
    body.image_url = await localizeImage(body.image_url) ?? body.image_url;
  }
  return body;
}

function queueEnrichment(table: ImportTable, entityId: number, row: Record<string, unknown>) {
  const meta = maybeEnqueueMetadataEnrichment({ entityType: table, entityId, row });
  const taste = maybeEnqueueTastingNotesEnrichment({ entityType: table, entityId, row });
  const image = maybeEnqueueImageEnrichment({ entityType: table, entityId, row });
  return [meta, taste, image].some((result) => result.enqueued);
}

const INVENTORY_WRITE_FIELDS: Record<ImportTable, string[]> = {
  spirits: ["name", "brand", "category", "sub_category", "abv", "volume_ml", "fill_level", "purchase_date", "opened_date", "shelf_location", "upc", "notes", "image_url", "stock_count", "tasting_notes", "flavors", "tags", "base_ingredient", "blocked_from_ordering"],
  packaged_beer: ["brewery", "name", "style", "count", "pack_date", "abv", "upc", "image_url", "notes", "tasting_notes", "flavors", "tags", "base_ingredient", "vessel"],
  wines: ["producer", "name", "varietal", "vintage", "type", "style", "region", "sweetness", "body", "bottle_count", "drink_by_date", "pairings", "notes", "upc", "image_url", "tasting_notes", "flavors", "tags", "base_ingredient", "blocked_from_ordering"]
};

function filterWriteFields(table: ImportTable, body: Record<string, unknown>) {
  const allowed = INVENTORY_WRITE_FIELDS[table];
  return allowed.filter((field) => body[field] !== undefined);
}

function insertInventoryRow(table: ImportTable, body: Record<string, unknown>) {
  const prepared = table === "packaged_beer"
    ? preparePackagedWrite(body)
    : table === "spirits"
      ? prepareSpiritWrite(body)
      : body;
  const columns = filterWriteFields(table, prepared);
  if (!columns.length) throw new Error("No valid fields supplied");
  const result = db.prepare(`
    INSERT INTO ${table} (${columns.join(",")})
    VALUES (${columns.map(() => "?").join(",")})
  `).run(...columns.map((key) => prepared[key]));
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(result.lastInsertRowid) as Record<string, unknown>;
}

function updateInventoryRow(table: ImportTable, id: number, body: Record<string, unknown>) {
  const prepared = table === "packaged_beer"
    ? preparePackagedWrite(body)
    : table === "spirits"
      ? prepareSpiritWrite(body)
      : body;
  const columns = filterWriteFields(table, prepared).filter((key) => key !== "id");
  if (!columns.length) throw new Error("No valid fields supplied");
  db.prepare(`
    UPDATE ${table}
    SET ${columns.map((key) => `${key} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(...columns.map((key) => prepared[key]), id);
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown>;
}

export async function saveScanSessionBottle(options: {
  code: string;
  kind: ImportKind;
}): Promise<ScanSessionSaveResult> {
  const upc = String(options.code ?? "").trim();
  const kind = options.kind;
  const base = {
    upc,
    table: null as ImportTable | null,
    moduleLabel: IMPORT_KIND_LABELS[kind] ?? "Inventory",
    enrichmentQueued: false
  };

  try {
    const lookup = await identifyByBarcode(upc, { kind, mode: "live" });
    const code = lookup.upc ?? upc;
    const name = lookupName(lookup);
    const table = lookup.table && SCAN_TABLES.has(lookup.table) ? lookup.table : null;

    if (lookup.source === "vault" && table && lookup.product) {
      const id = Number(lookup.product.id);
      if (!Number.isFinite(id) || id <= 0) {
        return { ...base, action: "failed", name: name || code, message: "Existing bottle record is invalid.", table };
      }
      const snapshot = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      if (!snapshot) {
        return { ...base, action: "failed", name: name || code, message: "Existing bottle record was not found.", table };
      }
      const field = quantityFieldForTable(table);
      const before = readQuantity(table, snapshot);
      const after = before + 1;
      const updatedBody = writeQuantity(table, snapshot, after);
      const saved = updateInventoryRow(table, id, updatedBody);
      const enrichmentQueued = queueEnrichment(table, id, saved);
      return {
        action: "updated",
        upc: code,
        name: lookupName({ ...lookup, product: saved }) || name || String(saved.name ?? "Bottle"),
        table,
        moduleLabel: MODULE_LABELS[table],
        message: `Already in vault. ${field.replace("_", " ")} updated: ${before} → ${after}.`,
        quantityField: field,
        quantityBefore: before,
        quantityAfter: after,
        enrichmentQueued,
        undo: { table, id, action: "updated", snapshot }
      };
    }

    if (lookup.reason || lookup.source === "not_found" || !lookupHasName(lookup.product)) {
      queueLookupResult({ ...lookup, upc: code, kind });
      return {
        action: "needs_review",
        upc: code,
        name: name || `UPC ${code}`,
        table,
        moduleLabel: table ? MODULE_LABELS[table] : base.moduleLabel,
        message: lookup.reason ? `Needs review (${lookup.reason}).` : "Needs review before it can be saved automatically.",
        enrichmentQueued: false,
        reason: lookup.reason
      };
    }

    const create = buildCreatePayload({ ...lookup, upc: code });
    if (!create) {
      return {
        action: "needs_review",
        upc: code,
        name: name || `UPC ${code}`,
        table,
        moduleLabel: base.moduleLabel,
        message: "Needs review — could not map this product to shelf inventory.",
        enrichmentQueued: false
      };
    }

    const body = await localizeBodyImage({ ...create.body });
    const saved = insertInventoryRow(create.table, body);
    const id = Number(saved.id);
    // Lookup/reference image is a fast fallback — not user/verified provenance.
    if (create.table === "spirits" || create.table === "packaged_beer" || create.table === "wines") {
      recordLookupImageFallback({
        entityType: create.table,
        entityId: id,
        url: saved.image_url == null ? null : String(saved.image_url)
      });
    }
    const enrichmentQueued = queueEnrichment(create.table, id, saved);
    return {
      action: "added",
      upc: code,
      name: String(saved.name ?? name ?? "Bottle"),
      table: create.table,
      moduleLabel: MODULE_LABELS[create.table],
      message: `Added to ${MODULE_LABELS[create.table]}. Enrichment queued in background.`,
      quantityField: quantityFieldForTable(create.table),
      quantityBefore: 0,
      quantityAfter: readQuantity(create.table, saved),
      enrichmentQueued,
      undo: { table: create.table, id, action: "added", snapshot: saved }
    };
  } catch (error) {
    return {
      ...base,
      action: "failed",
      name: upc,
      message: error instanceof Error ? error.message : "Scan save failed"
    };
  }
}

export function undoScanSessionMutation(undo: ScanSessionUndo): { ok: boolean; message: string } {
  if (!SCAN_TABLES.has(undo.table)) return { ok: false, message: "Unsupported inventory table." };
  const row = db.prepare(`SELECT * FROM ${undo.table} WHERE id=?`).get(undo.id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, message: "That scan result is no longer in the vault." };

  if (undo.action === "added") {
    db.prepare(`DELETE FROM ${undo.table} WHERE id=?`).run(undo.id);
    return { ok: true, message: "Removed the last scanned bottle." };
  }

  updateInventoryRow(undo.table, undo.id, undo.snapshot);
  return { ok: true, message: "Restored the previous quantity." };
}
