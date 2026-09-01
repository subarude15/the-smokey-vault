/**
 * Iowa Liquor Products CSV → shared government catalog SQLite.
 * Maps Iowa grain into the shared schema without PA row semantics.
 */
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalVolumeMl
} from "../../../canonical-normalize.js";
import { normalizeGovernmentBarcode } from "./barcode.js";
import {
  formatImportStats,
  getGovernmentDbPath,
  hashFileBuffer,
  hashText,
  markDatasetNotCurrent,
  openGovernmentDb
} from "./schema.js";
import { mapIowaTaxonomy } from "./taxonomy.js";
import type { GovernmentImportStats } from "./types.js";
import { iowaCategorySpecificity } from "../iowa-category.js";

export const IOWA_GOVERNMENT_HEADERS = [
  "item_no",
  "category_name",
  "im_desc",
  "vendor_no",
  "vendor_name",
  "bottle_volume_ml",
  "pack",
  "inner_pack",
  "age",
  "proof",
  "list_on",
  "upc",
  "scc",
  "state_bottle_cost",
  "state_case_cost",
  "state_bottle_retail",
  "report_as_of"
] as const;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function validateIowaGovernmentHeaders(headers: string[]): void {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const missing = IOWA_GOVERNMENT_HEADERS.filter((h) => !normalized.includes(h));
  if (missing.length) {
    throw new Error(`Iowa CSV missing required headers: ${missing.join(", ")}`);
  }
}

type IowaGovRow = {
  itemNo: string;
  categoryName: string;
  name: string;
  vendorNo: string | null;
  vendorName: string | null;
  volumeMl: number | null;
  volumeRaw: string | null;
  pack: number | null;
  proof: number | null;
  abv: number | null;
  reportAsOf: string | null;
  upcRaw: string;
  upc: ReturnType<typeof normalizeGovernmentBarcode>;
  scc: string | null;
  rowKey: string;
  payload: Record<string, string>;
};

type MutableProduct = {
  key: string;
  sourceItemId: string;
  name: string;
  brand: string | null;
  volumeMl: number | null;
  volumeRaw: string | null;
  casePack: number | null;
  proof: number | null;
  abvPercent: number | null;
  sourceGroup: string | null;
  normalizedFamily: string | null;
  normalizedSubcategory: string | null;
  sourceExtractedAt: string | null;
  qualityFlags: Set<string>;
  categorySpecificity: number;
  rowIds: number[];
  codes: Array<{
    sourceRowId: number;
    codeRaw: string;
    codeNormalized: string | null;
    comparisonKey: string | null;
    gtinType: string | null;
    checkDigitValid: number | null;
    qualityFlags: string[];
  }>;
};

function parseIowaGovRow(cells: Record<string, string>): IowaGovRow | null {
  const itemNo = String(cells.item_no ?? "").trim();
  const categoryName = String(cells.category_name ?? "").trim();
  const name = String(cells.im_desc ?? "").trim();
  if (!itemNo || !categoryName || !name) return null;

  const volumeRaw = String(cells.bottle_volume_ml ?? "").trim();
  const volumeMl = volumeRaw
    ? normalizeCanonicalVolumeMl(Number.parseInt(volumeRaw, 10))
    : null;

  const proof = normalizeCanonicalProof(cells.proof);
  const abv =
    proof != null ? normalizeCanonicalAbv(proof / 2, { productType: "spirit" }) : null;

  const packRaw = String(cells.pack ?? "").trim();
  const pack = packRaw ? Number.parseInt(packRaw, 10) : null;
  const reportAsOf = String(cells.report_as_of ?? "").trim() || null;
  const upcRaw = String(cells.upc ?? "").trim();
  const upc = normalizeGovernmentBarcode(upcRaw);
  const scc = String(cells.scc ?? "").trim() || null;
  const rowKey = `${reportAsOf ?? ""}::${itemNo}::${categoryName}`;

  return {
    itemNo,
    categoryName,
    name,
    vendorNo: String(cells.vendor_no ?? "").trim() || null,
    vendorName: String(cells.vendor_name ?? "").trim() || null,
    volumeMl,
    volumeRaw: volumeRaw || null,
    pack: Number.isFinite(pack as number) ? pack : null,
    proof,
    abv,
    reportAsOf,
    upcRaw,
    upc,
    scc,
    rowKey,
    payload: { ...cells }
  };
}

export async function importIowaGovernmentCsv(
  csvPath: string,
  options: { dbPath?: string } = {}
): Promise<GovernmentImportStats> {
  const abs = resolve(csvPath);
  const fileBuf = readFileSync(abs);
  const fileHash = hashFileBuffer(fileBuf);
  const dbPath = options.dbPath ?? getGovernmentDbPath();
  const db = openGovernmentDb(dbPath);

  const rl = createInterface({
    input: createReadStream(abs, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  let headers: string[] | null = null;
  const parsedRows: IowaGovRow[] = [];
  let rowsRead = 0;
  let validGtins = 0;
  let invalidGtins = 0;
  let flaggedBarcodes = 0;
  const itemCategories = new Map<string, Set<string>>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = parseCsvLine(line).map((h) => h.trim().toLowerCase());
      validateIowaGovernmentHeaders(headers);
      continue;
    }
    rowsRead++;
    const cellsRaw = parseCsvLine(line);
    const cells: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      cells[headers[i]!] = cellsRaw[i] ?? "";
    }
    const parsed = parseIowaGovRow(cells);
    if (!parsed) continue;
    if (parsed.upc.checkDigitValid === true) validGtins++;
    if (parsed.upc.checkDigitValid === false) invalidGtins++;
    if (parsed.upc.qualityFlags.length) flaggedBarcodes++;
    const cats = itemCategories.get(parsed.itemNo) ?? new Set<string>();
    cats.add(parsed.categoryName);
    itemCategories.set(parsed.itemNo, cats);
    parsedRows.push(parsed);
  }

  if (!headers) throw new Error("Iowa CSV is empty");

  const importedAt = new Date().toISOString();
  let extractionDate = "";
  for (const row of parsedRows) {
    if (row.reportAsOf) {
      extractionDate = row.reportAsOf;
      break;
    }
  }

  let rowsImported = 0;
  let productsWithProof = 0;
  const products = new Map<string, MutableProduct>();

  const run = db.transaction(() => {
    markDatasetNotCurrent(db, "iowa");
    const sourceInsert = db
      .prepare(
        `INSERT INTO catalog_sources (
          jurisdiction, dataset, source_version, extracted_at, imported_at,
          source_file_hash, source_file_name, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        "ia",
        "iowa",
        extractionDate || null,
        extractionDate || null,
        importedAt,
        fileHash,
        abs.split(/[/\\]/).pop() ?? abs
      );
    const sourceId = Number(sourceInsert.lastInsertRowid);

    const insertRow = db.prepare(`
      INSERT INTO catalog_source_rows (
        source_id, source_row_key, source_item_id, source_container_id,
        source_manufacturer_code, raw_payload_json, row_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProduct = db.prepare(`
      INSERT INTO catalog_products (
        source_id, source_item_id, domain, name, brand, volume_ml, volume_raw, case_pack,
        proof, abv_percent, abv_derivation, vintage_year, vintage_status, country, region_raw,
        source_division, source_group, source_class, normalized_family, normalized_subcategory,
        source_extracted_at, quality_flags_json, is_current
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, 1
      )
    `);
    const insertLink = db.prepare(
      `INSERT INTO catalog_product_rows (product_id, source_row_id) VALUES (?, ?)`
    );
    const insertCode = db.prepare(`
      INSERT INTO catalog_product_codes (
        product_id, source_row_id, code_raw, code_normalized, comparison_key, gtin_type,
        source_ordinal, check_digit_valid, is_preferred, quality_flags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of parsedRows) {
      const payload = JSON.stringify(row.payload);
      const rowHash = hashText(payload);
      const rowInsert = insertRow.run(
        sourceId,
        row.rowKey,
        row.itemNo,
        row.scc,
        row.vendorNo,
        payload,
        rowHash
      );
      const sourceRowId = Number(rowInsert.lastInsertRowid);
      rowsImported++;

      const productKey = [
        row.itemNo,
        row.name.toLowerCase(),
        String(row.volumeMl ?? ""),
        String(row.proof ?? "")
      ].join("::");

      const tax = mapIowaTaxonomy(row.categoryName);
      const specificity = iowaCategorySpecificity(row.categoryName);
      let product = products.get(productKey);

      if (!product) {
        const flags = new Set<string>();
        if (row.vendorName) flags.add("vendor_not_brand");
        if (specificity < 50) flags.add("generic_iowa_category");
        product = {
          key: productKey,
          sourceItemId: row.itemNo,
          name: row.name,
          brand: null,
          volumeMl: row.volumeMl,
          volumeRaw: row.volumeRaw,
          casePack: row.pack,
          proof: row.proof,
          abvPercent: row.abv,
          sourceGroup: row.categoryName,
          normalizedFamily: tax.normalizedFamily,
          normalizedSubcategory: tax.normalizedSubcategory,
          sourceExtractedAt: row.reportAsOf,
          qualityFlags: flags,
          categorySpecificity: specificity,
          rowIds: [],
          codes: []
        };
        products.set(productKey, product);
      } else if (specificity > product.categorySpecificity) {
        product.sourceGroup = row.categoryName;
        product.normalizedFamily = tax.normalizedFamily;
        product.normalizedSubcategory = tax.normalizedSubcategory;
        product.categorySpecificity = specificity;
        product.qualityFlags.delete("generic_iowa_category");
      }

      product.rowIds.push(sourceRowId);
      if (row.upcRaw) {
        product.codes.push({
          sourceRowId,
          codeRaw: row.upc.codeRaw || row.upcRaw,
          codeNormalized: row.upc.usable ? row.upc.codeNormalized : null,
          comparisonKey: row.upc.usable ? row.upc.comparisonKey : null,
          gtinType: row.upc.gtinType,
          checkDigitValid:
            row.upc.checkDigitValid == null ? null : row.upc.checkDigitValid ? 1 : 0,
          qualityFlags: row.upc.qualityFlags
        });
      }
    }

    let barcodeAliases = 0;
    for (const product of products.values()) {
      const productInsert = insertProduct.run(
        sourceId,
        product.sourceItemId,
        "spirit",
        product.name,
        product.brand,
        product.volumeMl,
        product.volumeRaw,
        product.casePack,
        product.proof,
        product.abvPercent,
        product.proof != null && product.abvPercent != null ? "us_proof_div_2" : null,
        null,
        null,
        null,
        null,
        null,
        product.sourceGroup,
        null,
        product.normalizedFamily,
        product.normalizedSubcategory,
        product.sourceExtractedAt,
        JSON.stringify([...product.qualityFlags])
      );
      const productId = Number(productInsert.lastInsertRowid);
      if (product.proof != null) productsWithProof++;
      for (const rowId of product.rowIds) insertLink.run(productId, rowId);
      let preferredSet = false;
      for (const code of product.codes) {
        const preferred =
          !preferredSet && code.codeNormalized && code.checkDigitValid === 1 ? 1 : 0;
        if (preferred) preferredSet = true;
        insertCode.run(
          productId,
          code.sourceRowId,
          code.codeRaw,
          code.codeNormalized,
          code.comparisonKey,
          code.gtinType,
          1,
          code.checkDigitValid,
          preferred,
          JSON.stringify(code.qualityFlags)
        );
        barcodeAliases++;
      }
    }

    return { barcodeAliases, productsNormalized: products.size };
  });

  const { barcodeAliases, productsNormalized } = run();

  const ambiguous = db
    .prepare(
      `
      SELECT comparison_key, COUNT(DISTINCT product_id) AS n
      FROM catalog_product_codes c
      JOIN catalog_products p ON p.id = c.product_id
      JOIN catalog_sources s ON s.id = p.source_id
      WHERE s.dataset = 'iowa' AND s.is_current = 1 AND c.comparison_key IS NOT NULL
      GROUP BY comparison_key
      HAVING n > 1
    `
    )
    .all() as Array<{ comparison_key: string; n: number }>;

  let duplicateSourceItemIds = 0;
  for (const cats of itemCategories.values()) {
    if (cats.size > 1) duplicateSourceItemIds++;
  }

  return {
    dataset: "iowa",
    rowsRead,
    rowsImported,
    productsNormalized,
    barcodeAliases,
    validGtins,
    invalidGtins,
    flaggedBarcodes,
    ambiguousBarcodeMappings: ambiguous.length,
    productsWithProof,
    productsWithOrigin: 0,
    productsWithRegion: 0,
    duplicateSourceItemIds,
    snapshotHash: fileHash,
    dbPath
  };
}

export function printIowaGovernmentImportStats(stats: GovernmentImportStats): string {
  return formatImportStats(stats);
}
