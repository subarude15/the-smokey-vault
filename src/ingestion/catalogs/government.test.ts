/**
 * Shared government alcohol catalog — PA PLCB + Iowa.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeExcelMatrix } from "./government/excel-matrix.js";
import {
  CONFIDENCE,
  PRODUCT_FIELD_SOURCES,
  SOURCE_CONFIDENCE,
  candidateFromProduct,
  mergeCandidates
} from "../candidate/index.js";
import {
  barcodeComparisonKey,
  normalizeGovernmentBarcode,
  validateGtinCheckDigit
} from "./government/barcode.js";
import {
  IOWA_GOVERNMENT_HEADERS,
  importIowaGovernmentCsv,
  validateIowaGovernmentHeaders
} from "./government/iowa-import.js";
import {
  governmentProductToSchema,
  searchGovernmentByBarcode
} from "./government/lookup.js";
import {
  importPaSpiritsWorkbook,
  importPaWinesWorkbook,
  importPaWorkbook
} from "./government/pa-import.js";
import {
  PA_EXPECTED_HEADERS,
  mapPaRow,
  normalizePaBrand,
  parsePaProof,
  validatePaHeaders
} from "./government/pa-columns.js";
import { rankGovernmentHits, type RankableHit } from "./government/rank.js";
import {
  DEFAULT_GOVERNMENT_DB_PATH,
  getGovernmentDbPath,
  openGovernmentDb,
  resetGovernmentDbConnection
} from "./government/schema.js";
import {
  isGiftOrSpecialtyPackage,
  mapIowaTaxonomy,
  mapPaSpiritsTaxonomy,
  mapPaWinesTaxonomy
} from "./government/taxonomy.js";
import type { CatalogProductRecord } from "./government/types.js";
import { parseGovernmentVolume } from "./government/volume.js";

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `gov-catalog-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

function withGovDb<T>(fn: (dbPath: string) => T): T {
  const dbPath = tempDbPath();
  const prev = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = dbPath;
  resetGovernmentDbConnection();
  try {
    return fn(dbPath);
  } finally {
    resetGovernmentDbConnection();
    if (prev === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = prev;
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
}

async function withGovDbAsync<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dbPath = tempDbPath();
  const prev = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = dbPath;
  resetGovernmentDbConnection();
  try {
    return await fn(dbPath);
  } finally {
    resetGovernmentDbConnection();
    if (prev === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = prev;
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
}

async function writePaWorkbook(
  rows: Array<Record<string, unknown> & { upcs?: string[] }>,
  filePath: string
): Promise<void> {
  const aoa: unknown[][] = [[...PA_EXPECTED_HEADERS]];
  for (const row of rows) {
    const upcs = row.upcs ?? ["", "", "", "", ""];
    let upcOrdinal = 0;
    aoa.push(
      PA_EXPECTED_HEADERS.map((header) => {
        if (header === "UPC") return upcs[upcOrdinal++] ?? "";
        return row[header] ?? "";
      })
    );
  }
  await writeExcelMatrix(aoa, filePath);
}

function marieRows(): Array<Record<string, unknown> & { upcs?: string[] }> {
  const shared = {
    "Division Name": "Stock Spirits",
    "Group Name": "Brandy-Cognac",
    "Class Name": "Armagnac",
    "PLCB Item": "000006481",
    "Item Description": "Marie Duffau Armagnac Napoleon",
    "Manufacturer SCC": "00008068648210",
    "Liquid Volume": "750 ml",
    "Case Pack": 12,
    "Current Regular Retail": 39.99,
    "Price Indicator": "N",
    Proof: 80,
    Vintage: "N/A",
    "Brand Name": "MARIE DUFFAU",
    "Import/Domestic": "Imported",
    Country: "France",
    Region: "",
    "Extraction Date": "2026-03-23"
  };
  return [
    {
      ...shared,
      "PLCB SCC Item": "10008068648217",
      upcs: ["091882064815", "000091882064815", "", "", ""]
    },
    {
      ...shared,
      "PLCB SCC Item": "20008068648214",
      upcs: ["91882064815", "", "", "", ""]
    }
  ];
}

function everclearRow(): Record<string, unknown> & { upcs?: string[] } {
  return {
    "Division Name": "Stock Spirits",
    "Group Name": "Grain Alcohol PERMIT ONLY",
    "Class Name": "Grain Alcohol PERMIT ONLY",
    "PLCB Item": "000008357",
    "Item Description": "Everclear Grain Alcohol PERMIT ONLY",
    "PLCB SCC Item": "100000290",
    "Manufacturer SCC": "00008835210003",
    "Liquid Volume": "750 ml",
    "Case Pack": 12,
    "Current Regular Retail": 22.99,
    "Price Indicator": "N",
    Proof: 190,
    Vintage: "N/A",
    "Brand Name": "EVERCLEAR",
    "Import/Domestic": "Imported",
    Country: "United States",
    Region: "",
    "Extraction Date": "2026-03-23",
    upcs: ["088352100036", "00088352100036", "", "", ""]
  };
}

function giftSetRow(): Record<string, unknown> & { upcs?: string[] } {
  return {
    "Division Name": "Stock Spirits",
    "Group Name": "Brandy-Cognac",
    "Class Name": "Armagnac",
    "PLCB Item": "000006481",
    "Item Description": "Marie Duffau Armagnac Napoleon Gift Set",
    "PLCB SCC Item": "10008068649999",
    "Manufacturer SCC": "00008068649999",
    "Liquid Volume": "750 ml",
    "Case Pack": 6,
    "Current Regular Retail": 49.99,
    "Price Indicator": "N",
    Proof: 80,
    Vintage: "N/A",
    "Brand Name": "MARIE DUFFAU",
    "Import/Domestic": "Imported",
    Country: "France",
    Region: "",
    "Extraction Date": "2026-03-23",
    upcs: ["080686499999", "", "", "", ""]
  };
}

function wineRows(): Array<Record<string, unknown> & { upcs?: string[] }> {
  return [
    {
      "Division Name": "Stock Wines",
      "Group Name": "Red Table",
      "Class Name": "Cabernet Sauvignon",
      "PLCB Item": "000100001",
      "Item Description": "Test Cabernet Estate",
      "PLCB SCC Item": "100100001001",
      "Manufacturer SCC": "00012345678901",
      "Liquid Volume": "750 ml",
      "Case Pack": 12,
      "Current Regular Retail": 14.99,
      "Price Indicator": "N",
      Proof: "N/A",
      Vintage: 2019,
      "Brand Name": "Test Estate",
      "Import/Domestic": "Imported",
      Country: "France",
      Region: "France - Bordeaux - Medoc - Haut-Medoc - Margaux",
      "Extraction Date": "2026-03-23",
      upcs: ["012345678905", "0012345678905", "", "", ""]
    },
    {
      "Division Name": "Stock Wines",
      "Group Name": "White Table",
      "Class Name": "Chardonnay",
      "PLCB Item": "000100002",
      "Item Description": "NV House Chardonnay",
      "PLCB SCC Item": "100100002001",
      "Manufacturer SCC": "00012345678902",
      "Liquid Volume": "748 ml",
      "Case Pack": 6,
      "Current Regular Retail": 9.99,
      "Price Indicator": "N",
      Proof: "N/A",
      Vintage: "NV",
      "Brand Name": "Not Found",
      "Import/Domestic": "Imported",
      Country: "United States",
      Region: "California - Napa Valley",
      "Extraction Date": "2026-03-23",
      upcs: ["012345678912", "", "", "", ""]
    }
  ];
}

function iowaCsv(lines: string[]): string {
  return `${IOWA_GOVERNMENT_HEADERS.join(",")}\n${lines.join("\n")}\n`;
}

function writeTempCsv(content: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `iowa-gov-${Date.now()}-${Math.random().toString(16).slice(2)}.csv`
  );
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function stubProduct(
  partial: Partial<CatalogProductRecord> & { id: number; name: string }
): CatalogProductRecord {
  return {
    id: partial.id,
    sourceId: partial.sourceId ?? partial.id,
    sourceItemId: partial.sourceItemId ?? String(partial.id),
    domain: partial.domain ?? "spirit",
    name: partial.name,
    brand: partial.brand ?? null,
    volumeMl: partial.volumeMl ?? 750,
    volumeRaw: partial.volumeRaw ?? "750 ml",
    casePack: partial.casePack ?? 12,
    proof: partial.proof ?? 80,
    abvPercent: partial.abvPercent ?? 40,
    abvDerivation: partial.abvDerivation ?? "us_proof_div_2",
    vintageYear: partial.vintageYear ?? null,
    vintageStatus: partial.vintageStatus ?? null,
    country: partial.country ?? null,
    regionRaw: partial.regionRaw ?? null,
    sourceDivision: partial.sourceDivision ?? null,
    sourceGroup: partial.sourceGroup ?? null,
    sourceClass: partial.sourceClass ?? null,
    normalizedFamily: partial.normalizedFamily ?? null,
    normalizedSubcategory: partial.normalizedSubcategory ?? null,
    sourceExtractedAt: partial.sourceExtractedAt ?? "2026-03-23",
    qualityFlagsJson: partial.qualityFlagsJson ?? null,
    isCurrent: partial.isCurrent ?? 1
  };
}

test("PA expected headers include five UPC columns and trailing Promotion Retail space", async () => {
  const upcIndexes = PA_EXPECTED_HEADERS.map((h, i) => (h === "UPC" ? i : -1)).filter(
    (i) => i >= 0
  );
  assert.equal(upcIndexes.length, 5);
  assert.ok(PA_EXPECTED_HEADERS.includes("Promotion Retail "));
  assert.equal(PA_EXPECTED_HEADERS.length, 34);
});

test("validatePaHeaders accepts the 34-column signature", async () => {
  assert.doesNotThrow(() => validatePaHeaders([...PA_EXPECTED_HEADERS]));
});

test("mapPaRow renames five UPC columns by ordinal and keeps Promotion Retail", async () => {
  let upcSeen = 0;
  const cells = PA_EXPECTED_HEADERS.map((h) => {
    if (h === "UPC") {
      upcSeen += 1;
      return `upc_${upcSeen}_raw`;
    }
    if (h === "Promotion Retail ") return "12.34";
    if (h === "PLCB SCC Item") return "SCC1";
    if (h === "Extraction Date") return "2026-03-23";
    if (h === "Item Description") return "Test";
    if (h === "PLCB Item") return "0001";
    return "";
  });
  const mapped = mapPaRow([...PA_EXPECTED_HEADERS], cells);
  assert.equal(mapped.upc_1, "upc_1_raw");
  assert.equal(mapped.upc_2, "upc_2_raw");
  assert.equal(mapped.upc_3, "upc_3_raw");
  assert.equal(mapped.upc_4, "upc_4_raw");
  assert.equal(mapped.upc_5, "upc_5_raw");
  assert.equal(mapped.promotion_retail, "12.34");
});

test("PLCB SCC Item is the PA raw-row identity with extraction date", async () => {
  const file = path.join(os.tmpdir(), `pa-scc-${Date.now()}.xlsx`);
  await writePaWorkbook(marieRows(), file);
  await withGovDbAsync(async (dbPath) => {
    const stats = await importPaSpiritsWorkbook(file, { dbPath });
    assert.equal(stats.rowsImported, 2);
    assert.equal(stats.duplicateSourceItemIds, 1);
    const db = openGovernmentDb(dbPath);
    const rows = db
      .prepare(
        `SELECT source_row_key, source_item_id, source_container_id FROM catalog_source_rows`
      )
      .all() as Array<{
      source_row_key: string;
      source_item_id: string;
      source_container_id: string | null;
    }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.source_item_id === "000006481"));
    assert.ok(
      rows.every(
        (r) =>
          r.source_row_key.includes("10008068648217") ||
          r.source_row_key.includes("20008068648214")
      )
    );
    assert.notEqual(rows[0]!.source_container_id, rows[1]!.source_container_id);
  });
  fs.unlinkSync(file);
});

test("product consolidation merges matching Marie rows but not gift sets", async () => {
  const file = path.join(os.tmpdir(), `pa-consol-${Date.now()}.xlsx`);
  await writePaWorkbook([...marieRows(), giftSetRow()], file);
  await withGovDbAsync(async (dbPath) => {
    const stats = await importPaSpiritsWorkbook(file, { dbPath });
    assert.equal(stats.rowsImported, 3);
    assert.equal(stats.productsNormalized, 2);
    assert.equal(isGiftOrSpecialtyPackage("Marie Duffau Armagnac Napoleon Gift Set"), true);
    assert.equal(isGiftOrSpecialtyPackage("Marie Duffau Armagnac Napoleon"), false);
  });
  fs.unlinkSync(file);
});

test("UPC leading zeros preserved and 12-digit UPC-A validates", () => {
  const n = normalizeGovernmentBarcode("036000291452");
  assert.equal(n.codeRaw, "036000291452");
  assert.equal(n.digits, "036000291452");
  assert.equal(n.gtinType, "gtin12");
  assert.equal(n.checkDigitValid, true);
  assert.equal(n.usable, true);
});

test("13-digit EAN-13 and 14-digit GTIN-14 typing", () => {
  const ean = normalizeGovernmentBarcode("0036000291452");
  assert.equal(ean.gtinType, "gtin13");
  assert.equal(ean.checkDigitValid, true);
  const gtin14 = normalizeGovernmentBarcode("10008068648217");
  assert.equal(gtin14.gtinType, "gtin14");
  assert.equal(typeof gtin14.checkDigitValid, "boolean");
});

test("8-digit GTIN-8 validation helper", async () => {
  assert.equal(validateGtinCheckDigit("96385074"), true);
  assert.equal(normalizeGovernmentBarcode("96385074").gtinType, "gtin8");
});

test("9-digit barcode is flagged for review", async () => {
  const n = normalizeGovernmentBarcode("806864821");
  assert.equal(n.gtinType, null);
  assert.ok(n.qualityFlags.includes("nine_digit_review"));
});

test("UPC-A and zero-prefixed EAN-13 share comparison key when valid", async () => {
  const upc = "036000291452";
  assert.equal(validateGtinCheckDigit(upc), true);
  const ean = `0${upc}`;
  assert.equal(validateGtinCheckDigit(ean), true);
  assert.equal(barcodeComparisonKey(upc), barcodeComparisonKey(ean));
  assert.equal(
    normalizeGovernmentBarcode(upc).comparisonKey,
    normalizeGovernmentBarcode(ean).comparisonKey
  );
});

test("scientific notation barcode is rejected rather than invented", async () => {
  const n = normalizeGovernmentBarcode("8.06864821e+11");
  assert.equal(n.usable, false);
  assert.ok(n.qualityFlags.includes("scientific_precision_lost"));
});

test("PA spirits taxonomy maps Brandy-Cognac to Armagnac", async () => {
  const t = mapPaSpiritsTaxonomy({
    divisionName: "Stock Spirits",
    groupName: "Brandy-Cognac",
    className: "Armagnac"
  });
  assert.equal(t.domain, "spirit");
  assert.equal(t.normalizedFamily, "Brandy/Cognac");
  assert.equal(t.normalizedSubcategory, "Armagnac");
});

test("PA wines taxonomy preserves group/class hierarchy", async () => {
  const t = mapPaWinesTaxonomy({
    divisionName: "Stock Wines",
    groupName: "Red Table",
    className: "Cabernet Sauvignon"
  });
  assert.equal(t.domain, "wine");
  assert.equal(t.normalizedFamily, "Red Table");
  assert.equal(t.normalizedSubcategory, "Cabernet Sauvignon");
});

test("Iowa taxonomy maps whiskey categories", async () => {
  const t = mapIowaTaxonomy("American Whiskies");
  assert.equal(t.domain, "spirit");
  assert.ok(t.normalizedFamily);
});

test("volume L to ml parsing and 748 ml preserved", async () => {
  assert.equal(parseGovernmentVolume("1.75 L").volumeMl, 1750);
  assert.equal(parseGovernmentVolume("1 L").volumeMl, 1000);
  assert.equal(parseGovernmentVolume("750 ml").volumeMl, 750);
  const odd = parseGovernmentVolume("748 ml");
  assert.equal(odd.volumeMl, 748);
  assert.equal(odd.volumeRaw, "748 ml");
});

test("PA proof parsing and Not Found brand", async () => {
  assert.equal(parsePaProof("80").proof, 80);
  assert.equal(parsePaProof("N/A").proof, null);
  assert.equal(parsePaProof("").proof, null);
  assert.equal(normalizePaBrand("Not Found"), null);
  assert.equal(normalizePaBrand("MARIE DUFFAU"), "MARIE DUFFAU");
});

test("PA spirits import: Marie Duffau + Everclear fixtures", async () => {
  const file = path.join(os.tmpdir(), `pa-spirits-fix-${Date.now()}.xlsx`);
  await writePaWorkbook([...marieRows(), everclearRow()], file);
  await withGovDbAsync(async (dbPath) => {
    const stats = await importPaSpiritsWorkbook(file, { dbPath });
    assert.ok(stats.rowsImported >= 3);
    assert.ok(stats.productsNormalized >= 2);
    assert.ok(stats.barcodeAliases >= 3);
    assert.ok(stats.productsWithProof >= 2);
    assert.ok(stats.productsWithOrigin >= 1);
    assert.ok(stats.snapshotHash.length > 10);

    const hit = searchGovernmentByBarcode("091882064815", { dbPath });
    assert.equal(hit.status, "hit");
    assert.ok(hit.winner);
    assert.equal(hit.winner.dataset, "plcb_spirits");
    assert.match(hit.winner.product.name, /Marie Duffau/i);
    assert.equal(hit.winner.product.proof, 80);
    assert.equal(hit.winner.product.abvPercent, 40);
    assert.equal(hit.winner.product.volumeMl, 750);
    assert.equal(hit.winner.product.country, "France");
    assert.equal(hit.winner.product.normalizedFamily, "Brandy/Cognac");
    assert.equal(hit.winner.product.normalizedSubcategory, "Armagnac");
    const schema = governmentProductToSchema(
      "091882064815",
      hit.winner.product,
      hit.winner.matchedCodeRaw
    );
    assert.equal(schema.abv, 40);
    assert.equal(schema.proof, 80);
    assert.equal(schema.origin, "France");
    assert.notEqual(schema.origin, "Imported");

    const ever = searchGovernmentByBarcode("088352100036", { dbPath });
    assert.equal(ever.status, "hit");
    assert.ok(ever.winner);
    assert.equal(ever.winner.product.proof, 190);
    assert.equal(ever.winner.product.abvPercent, 95);
    assert.match(ever.winner.product.sourceClass ?? "", /PERMIT ONLY/i);
    assert.match(ever.winner.product.normalizedFamily ?? "", /Grain Alcohol/i);
  });
  fs.unlinkSync(file);
});

test("PA wines import: N/A proof, region, Not Found brand, 748 ml", async () => {
  const file = path.join(os.tmpdir(), `pa-wines-fix-${Date.now()}.xlsx`);
  await writePaWorkbook(wineRows(), file);
  await withGovDbAsync(async (dbPath) => {
    const stats = await importPaWinesWorkbook(file, { dbPath });
    assert.equal(stats.rowsImported, 2);
    assert.ok(stats.productsWithRegion >= 1);

    const cab = searchGovernmentByBarcode("012345678905", { dbPath });
    assert.equal(cab.status, "hit");
    assert.ok(cab.winner);
    assert.equal(cab.winner.dataset, "plcb_wines");
    assert.equal(cab.winner.product.abvPercent, null);
    assert.equal(cab.winner.product.proof, null);
    assert.equal(cab.winner.product.vintageYear, 2019);
    assert.match(cab.winner.product.regionRaw ?? "", /Margaux/);
    assert.equal(cab.winner.product.country, "France");

    const nv = searchGovernmentByBarcode("012345678912", { dbPath });
    assert.equal(nv.status, "hit");
    assert.ok(nv.winner);
    assert.equal(nv.winner.product.brand, null);
    assert.equal(nv.winner.product.volumeMl, 748);
    assert.equal(nv.winner.product.vintageStatus, "nonvintage");
  });
  fs.unlinkSync(file);
});

test("Iowa government import maps into shared schema; vendor is not brand", async () => {
  const csv = writeTempCsv(
    iowaCsv([
      '11788,"100% Agave Tequila","CASAMIGOS REPOSADO",421,"SAZERAC COMPANY  INC",750,6,1,"",80.0,"2024-01-01",080480160053,"",16.5,99,24.75,"2026-03-01"',
      '11788,"Tequila","CASAMIGOS REPOSADO",421,"SAZERAC COMPANY  INC",750,6,1,"",80.0,"2024-01-01",080480160053,"",16.5,99,24.75,"2026-03-01"'
    ])
  );
  await withGovDbAsync(async (dbPath) => {
    assert.doesNotThrow(() => validateIowaGovernmentHeaders([...IOWA_GOVERNMENT_HEADERS]));
    const stats = await importIowaGovernmentCsv(csv, { dbPath });
    assert.equal(stats.rowsImported, 2);
    assert.equal(stats.duplicateSourceItemIds, 1);
    assert.equal(stats.productsNormalized, 1);

    const hit = searchGovernmentByBarcode("080480160053", { dbPath });
    assert.equal(hit.status, "hit");
    assert.ok(hit.winner);
    assert.equal(hit.winner.dataset, "iowa");
    assert.equal(hit.winner.product.proof, 80);
    assert.equal(hit.winner.product.abvPercent, 40);
    assert.equal(hit.winner.product.brand, null);
    assert.equal(hit.winner.product.volumeMl, 750);
    assert.match(hit.winner.product.sourceGroup ?? "", /Agave/i);
  });
  fs.unlinkSync(csv);
});

test("barcode collisions return multiple candidates or ambiguous when material conflict", async () => {
  const rows = [
    {
      ...everclearRow(),
      upcs: ["012345678905", "", "", "", ""],
      "PLCB SCC Item": "100000000001"
    },
    {
      ...marieRows()[0]!,
      upcs: ["012345678905", "", "", "", ""],
      "PLCB SCC Item": "100000000002",
      "PLCB Item": "000099999",
      "Item Description": "Totally Different Brandy",
      Proof: 86
    }
  ];
  const file = path.join(os.tmpdir(), `pa-collide-${Date.now()}.xlsx`);
  await writePaWorkbook(rows, file);
  await withGovDbAsync(async (dbPath) => {
    await importPaSpiritsWorkbook(file, { dbPath });
    const hit = searchGovernmentByBarcode("012345678905", { dbPath });
    assert.ok(hit.status === "ambiguous" || hit.status === "hit");
    if (hit.status === "ambiguous") {
      assert.ok(hit.candidates.length >= 2);
    }
  });
  fs.unlinkSync(file);
});

test("exact raw barcode match ranks above comparison-key-only match", async () => {
  const hits: RankableHit[] = [
    {
      product: stubProduct({
        id: 1,
        name: "Exact",
        brand: "A",
        normalizedFamily: "Whiskey",
        normalizedSubcategory: "Bourbon",
        sourceGroup: "Whiskey",
        sourceClass: "Bourbon",
        country: "United States"
      }),
      dataset: "plcb_spirits",
      matchedCodeRaw: "036000291452",
      matchedCodeNormalized: "036000291452",
      exactRawMatch: true,
      isCurrent: true,
      extractedAt: "2026-03-23"
    },
    {
      product: stubProduct({
        id: 2,
        name: "Compat",
        brand: null,
        casePack: 6,
        volumeRaw: "750",
        normalizedFamily: "Whiskey",
        sourceGroup: "Whiskey",
        sourceExtractedAt: "2026-03-01"
      }),
      dataset: "iowa",
      matchedCodeRaw: "0036000291452",
      matchedCodeNormalized: "0036000291452",
      exactRawMatch: false,
      isCurrent: true,
      extractedAt: "2026-03-01"
    }
  ];
  const ranked = rankGovernmentHits(hits);
  assert.equal(ranked.status, "hit");
  assert.equal(ranked.winner?.product.name, "Exact");
});

test("PA and Iowa agreement retains independent source products", async () => {
  const file = path.join(os.tmpdir(), `pa-agree-${Date.now()}.xlsx`);
  await writePaWorkbook(
    [
      {
        ...everclearRow(),
        "Item Description": "Shared Bourbon Example",
        "PLCB Item": "000055555",
        "PLCB SCC Item": "100055555001",
        "Brand Name": "SHARED",
        "Group Name": "Whiskey",
        "Class Name": "Bourbon",
        Proof: 80,
        Country: "United States",
        upcs: ["080480160053", "", "", "", ""]
      }
    ],
    file
  );
  const csv = writeTempCsv(
    iowaCsv([
      '55555,"Straight Bourbon Whiskies","Shared Bourbon Example",1,"VENDOR CO",750,6,1,"",80.0,"2024-01-01",080480160053,"",10,60,15,"2026-03-01"'
    ])
  );
  await withGovDbAsync(async (dbPath) => {
    await importPaSpiritsWorkbook(file, { dbPath });
    await importIowaGovernmentCsv(csv, { dbPath });
    const db = openGovernmentDb(dbPath);
    const datasets = db
      .prepare(
        `SELECT s.dataset AS dataset
         FROM catalog_products p
         JOIN catalog_sources s ON s.id = p.source_id`
      )
      .all() as Array<{ dataset: string }>;
    assert.ok(datasets.some((d) => d.dataset === "plcb_spirits"));
    assert.ok(datasets.some((d) => d.dataset === "iowa"));
    const hit = searchGovernmentByBarcode("080480160053", { dbPath });
    assert.ok(hit.status === "hit" || hit.status === "ambiguous");
  });
  fs.unlinkSync(file);
  fs.unlinkSync(csv);
});

test("PA/Iowa proof disagreement keeps both proofs auditable", async () => {
  const file = path.join(os.tmpdir(), `pa-disagree-${Date.now()}.xlsx`);
  await writePaWorkbook(
    [
      {
        ...everclearRow(),
        "Item Description": "Conflict Spirit",
        "PLCB Item": "000066666",
        "PLCB SCC Item": "100066666001",
        Proof: 80,
        "Group Name": "Whiskey",
        "Class Name": "Bourbon",
        upcs: ["080480160099", "", "", "", ""]
      }
    ],
    file
  );
  const csv = writeTempCsv(
    iowaCsv([
      '66666,"Straight Bourbon Whiskies","Conflict Spirit",1,"VENDOR",750,6,1,"",86.0,"2024-01-01",080480160099,"",10,60,15,"2026-03-01"'
    ])
  );
  await withGovDbAsync(async (dbPath) => {
    await importPaSpiritsWorkbook(file, { dbPath });
    await importIowaGovernmentCsv(csv, { dbPath });
    const hit = searchGovernmentByBarcode("080480160099", { dbPath });
    const db = openGovernmentDb(dbPath);
    const proofs = db
      .prepare(
        `SELECT proof FROM catalog_products WHERE source_item_id IN ('000066666','66666')`
      )
      .all() as Array<{ proof: number }>;
    assert.ok(proofs.some((p) => p.proof === 80));
    assert.ok(proofs.some((p) => p.proof === 86));
    assert.ok(hit.status === "hit" || hit.status === "ambiguous");
  });
  fs.unlinkSync(file);
  fs.unlinkSync(csv);
});

test("government HIGH confidence does not overwrite Vault/user VERY_HIGH", async () => {
  assert.equal(SOURCE_CONFIDENCE.plcb_spirits, CONFIDENCE.HIGH);
  assert.equal(SOURCE_CONFIDENCE.plcb_wines, CONFIDENCE.HIGH);
  assert.equal(SOURCE_CONFIDENCE.iowa, CONFIDENCE.HIGH);
  assert.equal(SOURCE_CONFIDENCE.user, CONFIDENCE.VERY_HIGH);
  assert.equal(SOURCE_CONFIDENCE.vault, CONFIDENCE.VERY_HIGH);
  assert.ok(PRODUCT_FIELD_SOURCES.includes("plcb_spirits"));

  const vault = candidateFromProduct(
    { name: "Vault Verified Name", brand: "Vault", upc: "036000291452", abv: 40 },
    "user"
  );
  const gov = candidateFromProduct(
    { name: "Government Name", brand: "Gov", upc: "036000291452", abv: 42 },
    "plcb_spirits"
  );
  const merged = mergeCandidates(vault, gov);
  assert.equal(merged.candidate.name.value, "Vault Verified Name");
  assert.equal(merged.candidate.name.source, "user");
  assert.ok(merged.conflicts.some((c) => c.field === "name"));
});

test("government DB path helpers", async () => {
  assert.ok(String(DEFAULT_GOVERNMENT_DB_PATH).includes("government"));
  assert.equal(typeof getGovernmentDbPath(), "string");
});

test("snapshot imports retain prior rows", async () => {
  const file1 = path.join(os.tmpdir(), `pa-snap1-${Date.now()}.xlsx`);
  const file2 = path.join(os.tmpdir(), `pa-snap2-${Date.now()}.xlsx`);
  await writePaWorkbook(marieRows(), file1);
  await writePaWorkbook(
    marieRows().map((r) => ({
      ...r,
      "Extraction Date": "2026-04-01",
      "Current Regular Retail": 41.99
    })),
    file2
  );
  await withGovDbAsync(async (dbPath) => {
    await importPaSpiritsWorkbook(file1, { dbPath });
    await importPaSpiritsWorkbook(file2, { dbPath });
    const db = openGovernmentDb(dbPath);
    const sources = db.prepare(`SELECT COUNT(*) AS c FROM catalog_sources`).get() as {
      c: number;
    };
    assert.ok(sources.c >= 2);
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM catalog_source_rows`).get() as {
      c: number;
    };
    assert.ok(rows.c >= 4);
  });
  fs.unlinkSync(file1);
  fs.unlinkSync(file2);
});

test("hash stability for identical workbook bytes", async () => {
  const file = path.join(os.tmpdir(), `pa-hash-${Date.now()}.xlsx`);
  await writePaWorkbook(marieRows(), file);
  const a = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const b = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(a, b);
  fs.unlinkSync(file);
});

test("importPaWorkbook accepts plcb_wines dataset", async () => {
  const file = path.join(os.tmpdir(), `pa-domain-${Date.now()}.xlsx`);
  await writePaWorkbook(wineRows(), file);
  await withGovDbAsync(async (dbPath) => {
    const stats = await importPaWorkbook(file, { dataset: "plcb_wines", dbPath });
    assert.equal(stats.dataset, "plcb_wines");
    assert.ok(stats.rowsImported >= 1);
  });
  fs.unlinkSync(file);
});
