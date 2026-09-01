/**
 * PA PLCB workbook → shared government catalog SQLite.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { normalizeCanonicalAbv, normalizeCanonicalProof } from "../../../canonical-normalize.js";
import { normalizeGovernmentBarcode } from "./barcode.js";
import {
  formatImportStats,
  getGovernmentDbPath,
  hashFileBuffer,
  hashText,
  markDatasetNotCurrent,
  openGovernmentDb
} from "./schema.js";
import {
  mapPaRow,
  normalizePaBrand,
  paCell,
  parsePaProof,
  parsePaVintage,
  paSourceRowKey,
  validatePaHeaders,
  type PaRawRow
} from "./pa-columns.js";
import { isGiftOrSpecialtyPackage, mapPaSpiritsTaxonomy, mapPaWinesTaxonomy } from "./taxonomy.js";
import type { CatalogDomain, GovernmentDataset, GovernmentImportStats } from "./types.js";
import { parseGovernmentVolume } from "./volume.js";

export type PaImportOptions = {
  dbPath?: string;
  dataset: Extract<GovernmentDataset, "plcb_spirits" | "plcb_wines">;
};

type MutableProduct = {
  key: string;
  sourceItemId: string;
  domain: CatalogDomain;
  name: string;
  brand: string | null;
  volumeMl: number | null;
  volumeRaw: string | null;
  casePack: number | null;
  proof: number | null;
  abvPercent: number | null;
  abvDerivation: string | null;
  vintageYear: number | null;
  vintageStatus: string | null;
  country: string | null;
  regionRaw: string | null;
  sourceDivision: string | null;
  sourceGroup: string | null;
  sourceClass: string | null;
  normalizedFamily: string | null;
  normalizedSubcategory: string | null;
  sourceExtractedAt: string | null;
  qualityFlags: Set<string>;
  rowIds: number[];
  codes: Array<{
    sourceRowId: number;
    codeRaw: string;
    codeNormalized: string | null;
    comparisonKey: string | null;
    gtinType: string | null;
    sourceOrdinal: number;
    checkDigitValid: number | null;
    qualityFlags: string[];
  }>;
};

function consolidationKey(row: PaRawRow, domain: CatalogDomain): string {
  const item = paCell(row, "plcb_item");
  const name = paCell(row, "item_description").toLowerCase();
  const brand = (normalizePaBrand(paCell(row, "brand_name")) ?? "").toLowerCase();
  const volume = paCell(row, "liquid_volume").toLowerCase();
  const group = paCell(row, "group_name").toLowerCase();
  const klass = paCell(row, "class_name").toLowerCase();
  const proof = paCell(row, "proof").toLowerCase();
  const vintage = paCell(row, "vintage").toLowerCase();
  const gift = isGiftOrSpecialtyPackage(paCell(row, "item_description")) ? "gift" : "base";
  return [domain, item, name, brand, volume, group, klass, proof, vintage, gift].join("::");
}

function canConsolidate(existing: MutableProduct, row: PaRawRow): boolean {
  const rowGift = isGiftOrSpecialtyPackage(paCell(row, "item_description"));
  const existingGift = existing.qualityFlags.has("gift_or_specialty_package");
  if (rowGift !== existingGift) return false;
  if (paCell(row, "plcb_item") !== existing.sourceItemId) return false;
  if (paCell(row, "item_description") !== existing.name) return false;
  if ((normalizePaBrand(paCell(row, "brand_name")) ?? null) !== existing.brand) return false;
  if (paCell(row, "liquid_volume") !== (existing.volumeRaw ?? "")) return false;
  return true;
}

export function importPaWorkbook(filePath: string, options: PaImportOptions): GovernmentImportStats {
  const abs = resolve(filePath);
  const fileBuf = readFileSync(abs);
  const fileHash = hashFileBuffer(fileBuf);
  const workbook = XLSX.read(fileBuf, { type: "buffer", cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("PA workbook has no sheets");
  const sheet = workbook.Sheets[sheetName]!;
  const matrix = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: "",
    raw: false
  }) as unknown as unknown[][];
  if (!matrix.length) throw new Error("PA workbook is empty");

  const headerRow = (matrix[0] ?? []).map((h) => String(h ?? ""));
  validatePaHeaders(headerRow);

  const domain: CatalogDomain = options.dataset === "plcb_wines" ? "wine" : "spirit";
  const dbPath = options.dbPath ?? getGovernmentDbPath();
  const db = openGovernmentDb(dbPath);

  let rowsRead = 0;
  let rowsImported = 0;
  let validGtins = 0;
  let invalidGtins = 0;
  let flaggedBarcodes = 0;
  let productsWithProof = 0;
  let productsWithOrigin = 0;
  let productsWithRegion = 0;
  const itemIdCounts = new Map<string, number>();
  const products = new Map<string, MutableProduct>();
  let extractionDate = "";
  const importedAt = new Date().toISOString();

  const run = db.transaction(() => {
    markDatasetNotCurrent(db, options.dataset);

    for (let r = 1; r < matrix.length; r++) {
      const cells = matrix[r] ?? [];
      if (!cells.some((c) => String(c ?? "").trim())) continue;
      rowsRead++;
      const row = mapPaRow(headerRow, cells);
      const scc = paCell(row, "plcb_scc_item");
      const item = paCell(row, "plcb_item");
      if (!scc || !item) continue;
      extractionDate = paCell(row, "extraction_date") || extractionDate;
      itemIdCounts.set(item, (itemIdCounts.get(item) ?? 0) + 1);
    }

    const sourceInsert = db
      .prepare(
        `INSERT INTO catalog_sources (
          jurisdiction, dataset, source_version, extracted_at, imported_at,
          source_file_hash, source_file_name, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        "pa",
        options.dataset,
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

    for (let r = 1; r < matrix.length; r++) {
      const cells = matrix[r] ?? [];
      if (!cells.some((c) => String(c ?? "").trim())) continue;
      const row = mapPaRow(headerRow, cells);
      const scc = paCell(row, "plcb_scc_item");
      const item = paCell(row, "plcb_item");
      if (!scc || !item) continue;

      const extracted = paCell(row, "extraction_date");
      const rowKey = paSourceRowKey(extracted, scc);
      const payload = JSON.stringify(row);
      const rowHash = hashText(payload);
      const rowInsert = insertRow.run(
        sourceId,
        rowKey,
        item,
        scc,
        paCell(row, "manufacturer_scc") || null,
        payload,
        rowHash
      );
      const sourceRowId = Number(rowInsert.lastInsertRowid);
      rowsImported++;

      const key = consolidationKey(row, domain);
      let product = products.get(key);
      if (product && !canConsolidate(product, row)) {
        product = undefined;
      }

      if (!product) {
        const volume = parseGovernmentVolume(paCell(row, "liquid_volume"));
        const brand = normalizePaBrand(paCell(row, "brand_name"));
        const proofParse = parsePaProof(paCell(row, "proof"));
        const proof =
          proofParse.proof != null ? normalizeCanonicalProof(proofParse.proof) : null;
        const abv =
          proof != null
            ? normalizeCanonicalAbv(proof / 2, {
                productType: domain === "wine" ? "wine" : "spirit"
              })
            : null;
        const vintage = parsePaVintage(paCell(row, "vintage"));
        const tax =
          domain === "wine"
            ? mapPaWinesTaxonomy({
                divisionName: paCell(row, "division_name"),
                groupName: paCell(row, "group_name"),
                className: paCell(row, "class_name")
              })
            : mapPaSpiritsTaxonomy({
                divisionName: paCell(row, "division_name"),
                groupName: paCell(row, "group_name"),
                className: paCell(row, "class_name")
              });
        const flags = new Set<string>([
          ...volume.qualityFlags,
          ...proofParse.flags,
          ...tax.qualityFlags
        ]);
        flags.add("import_domestic_ignored");
        if (isGiftOrSpecialtyPackage(paCell(row, "item_description"))) {
          flags.add("gift_or_specialty_package");
        }
        const casePackRaw = paCell(row, "case_pack");
        const casePack = casePackRaw ? Number.parseInt(casePackRaw, 10) : null;

        product = {
          key,
          sourceItemId: item,
          domain,
          name: paCell(row, "item_description"),
          brand,
          volumeMl: volume.volumeMl,
          volumeRaw: volume.volumeRaw,
          casePack: Number.isFinite(casePack as number) ? casePack : null,
          proof,
          abvPercent: abv,
          abvDerivation: proof != null && abv != null ? "us_proof_div_2" : null,
          vintageYear: vintage.vintageYear,
          vintageStatus: vintage.vintageStatus,
          country: paCell(row, "country") || null,
          regionRaw: paCell(row, "region") || null,
          sourceDivision: paCell(row, "division_name") || null,
          sourceGroup: paCell(row, "group_name") || null,
          sourceClass: paCell(row, "class_name") || null,
          normalizedFamily: tax.normalizedFamily,
          normalizedSubcategory: tax.normalizedSubcategory,
          sourceExtractedAt: extracted || null,
          qualityFlags: flags,
          rowIds: [],
          codes: []
        };

        let uniqueKey = key;
        let n = 1;
        while (products.has(uniqueKey) && products.get(uniqueKey) !== product) {
          uniqueKey = `${key}::split::${n++}`;
        }
        product.key = uniqueKey;
        products.set(uniqueKey, product);
      }

      product.rowIds.push(sourceRowId);
      for (const ordinal of [1, 2, 3, 4, 5] as const) {
        const raw = paCell(row, `upc_${ordinal}`);
        if (!raw) continue;
        const norm = normalizeGovernmentBarcode(raw);
        if (norm.checkDigitValid === true) validGtins++;
        if (norm.checkDigitValid === false) invalidGtins++;
        if (norm.qualityFlags.length) flaggedBarcodes++;
        product.codes.push({
          sourceRowId,
          codeRaw: norm.codeRaw || raw,
          codeNormalized: norm.codeNormalized,
          comparisonKey: norm.comparisonKey,
          gtinType: norm.gtinType,
          sourceOrdinal: ordinal,
          checkDigitValid:
            norm.checkDigitValid == null ? null : norm.checkDigitValid ? 1 : 0,
          qualityFlags: norm.qualityFlags
        });
      }
    }

    let barcodeAliases = 0;
    for (const product of products.values()) {
      const productInsert = insertProduct.run(
        sourceId,
        product.sourceItemId,
        product.domain,
        product.name,
        product.brand,
        product.volumeMl,
        product.volumeRaw,
        product.casePack,
        product.proof,
        product.abvPercent,
        product.abvDerivation,
        product.vintageYear,
        product.vintageStatus,
        product.country,
        product.regionRaw,
        product.sourceDivision,
        product.sourceGroup,
        product.sourceClass,
        product.normalizedFamily,
        product.normalizedSubcategory,
        product.sourceExtractedAt,
        JSON.stringify([...product.qualityFlags])
      );
      const productId = Number(productInsert.lastInsertRowid);
      if (product.proof != null) productsWithProof++;
      if (product.country) productsWithOrigin++;
      if (product.regionRaw) productsWithRegion++;
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
          code.sourceOrdinal,
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
      WHERE s.dataset = ? AND s.is_current = 1 AND c.comparison_key IS NOT NULL
      GROUP BY comparison_key
      HAVING n > 1
    `
    )
    .all(options.dataset) as Array<{ comparison_key: string; n: number }>;

  let duplicateSourceItemIds = 0;
  for (const count of itemIdCounts.values()) {
    if (count > 1) duplicateSourceItemIds++;
  }

  return {
    dataset: options.dataset,
    rowsRead,
    rowsImported,
    productsNormalized,
    barcodeAliases,
    validGtins,
    invalidGtins,
    flaggedBarcodes,
    ambiguousBarcodeMappings: ambiguous.length,
    productsWithProof,
    productsWithOrigin,
    productsWithRegion,
    duplicateSourceItemIds,
    snapshotHash: fileHash,
    dbPath
  };
}

export function importPaSpiritsWorkbook(
  filePath: string,
  options: { dbPath?: string } = {}
): GovernmentImportStats {
  return importPaWorkbook(filePath, { ...options, dataset: "plcb_spirits" });
}

export function importPaWinesWorkbook(
  filePath: string,
  options: { dbPath?: string } = {}
): GovernmentImportStats {
  return importPaWorkbook(filePath, { ...options, dataset: "plcb_wines" });
}

export function printPaImportStats(stats: GovernmentImportStats): string {
  return formatImportStats(stats);
}
