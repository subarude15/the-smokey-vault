/**
 * Government catalog provenance: contribution, confirmation, conflict, Keeper UI, diagnostics.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { db } from "../../db.js";
import { saveBarcodeCacheEntry } from "../../barcode_cache.js";
import {
  CONFIDENCE,
  candidateFromProduct,
  field,
  mergeField,
  type BottleCandidate
} from "../candidate/index.js";
import { writeExcelMatrix } from "../catalogs/government/excel-matrix.js";
import { importPaSpiritsWorkbook } from "../catalogs/government/pa-import.js";
import { PA_EXPECTED_HEADERS } from "../catalogs/government/pa-columns.js";
import {
  resetGovernmentDbConnection,
  searchGovernmentByBarcode
} from "../catalogs/government/index.js";
import {
  applyGovernmentCatalogEvidence,
  logGovernmentEvidenceOutcome
} from "../enrichment/government-evidence.js";
import {
  executeMetadataEnrichment,
  planEnrichment,
  type EnrichmentPlan
} from "../enrichment/index.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  sourceLabel
} from "../jobs/index.js";

const CAPTAIN_UPC = "087000201156";
const CAPTAIN_ITEM = "000004766";

function tempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `gov-prov-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

async function writeCaptainMorganWorkbook(filePath: string): Promise<void> {
  const row: Record<string, unknown> & { upcs?: string[] } = {
    "Division Name": "Stock Spirits",
    "Group Name": "Rum",
    "Class Name": "Spiced Rum",
    "PLCB Item": CAPTAIN_ITEM,
    "Item Description": "Captain Morgan Original Spiced Rum",
    "PLCB SCC Item": "10008700020115",
    "Manufacturer SCC": "00008700020115",
    "Liquid Volume": "1.75 L",
    "Case Pack": 6,
    "Current Regular Retail": 29.99,
    "Price Indicator": "N",
    Proof: 70,
    Vintage: "N/A",
    "Brand Name": "CAPTAIN MORGAN",
    "Import/Domestic": "Domestic",
    Country: "United States",
    Region: "",
    "Extraction Date": "2026-03-23",
    upcs: [CAPTAIN_UPC, "", "", "", ""]
  };
  let upcOrdinal = 0;
  const upcs = row.upcs ?? [];
  const aoa: unknown[][] = [
    [...PA_EXPECTED_HEADERS],
    PA_EXPECTED_HEADERS.map((header) => {
      if (header === "UPC") return upcs[upcOrdinal++] ?? "";
      return row[header] ?? "";
    })
  ];
  await writeExcelMatrix(aoa, filePath);
}

async function withCaptainGovDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dbPath = tempDbPath();
  const prev = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = dbPath;
  resetGovernmentDbConnection();
  const workbook = path.join(os.tmpdir(), `captain-${Date.now()}.xlsx`);
  try {
    await writeCaptainMorganWorkbook(workbook);
    await importPaSpiritsWorkbook(workbook, { dbPath });
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
    try {
      fs.unlinkSync(workbook);
    } catch {
      /* ignore */
    }
  }
}

function barcodeCacheCandidate(overrides: Partial<{
  proof: number | null;
  abv: number | null;
  origin: string | null;
  volume_ml: number | null;
}> = {}): BottleCandidate {
  return candidateFromProduct(
    {
      upc: CAPTAIN_UPC,
      name: "Captain Morgan Original Spiced Rum",
      brand: "Captain Morgan",
      category: "Rum",
      abv: overrides.abv === undefined ? 35 : overrides.abv,
      proof: overrides.proof === undefined ? 70 : overrides.proof,
      volume_ml: overrides.volume_ml === undefined ? 1750 : overrides.volume_ml,
      origin: overrides.origin === undefined ? null : overrides.origin,
      product_type: "spirit"
    },
    "barcode_cache"
  );
}

function vaultCandidate(overrides: Partial<{
  proof: number | null;
  origin: string | null;
}> = {}): BottleCandidate {
  return candidateFromProduct(
    {
      upc: CAPTAIN_UPC,
      name: "Captain Morgan Original Spiced Rum",
      brand: "Captain Morgan",
      category: "Rum",
      abv: 35,
      proof: overrides.proof === undefined ? 70 : overrides.proof,
      volume_ml: 1750,
      origin: overrides.origin === undefined ? null : overrides.origin,
      product_type: "spirit"
    },
    "vault"
  );
}

function metadataPlan(candidate: BottleCandidate): EnrichmentPlan {
  return planEnrichment(candidate);
}

function insertCaptainSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    category: "Rum",
    abv: 35,
    volume_ml: 1750,
    upc: CAPTAIN_UPC,
    notes:
      "Gov proof: 70 | Origin: United States | Source item: 000004766 | Matched code: 087000201156",
    ...overrides
  };
  const result = db
    .prepare(
      `
    INSERT INTO spirits (
      name, brand, category, abv, volume_ml, upc, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      row.name,
      row.brand,
      row.category,
      row.abv,
      row.volume_ml,
      row.upc,
      row.notes
    );
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function cleanupCaptain() {
  clearEnrichmentJobsForTests();
  db.prepare(`DELETE FROM spirits WHERE upc=?`).run(CAPTAIN_UPC);
  db.prepare(`DELETE FROM barcode_cache WHERE upc=?`).run(CAPTAIN_UPC);
}

test("source labels stay distinct for PLCB Spirits, PLCB Wines, and Iowa", () => {
  assert.equal(sourceLabel("plcb_spirits"), "PLCB Spirits");
  assert.equal(sourceLabel("plcb_wines"), "PLCB Wines");
  assert.equal(sourceLabel("iowa"), "Iowa");
});

test("mergeField records confirmation without changing canonical value or confidence", () => {
  const existing = field(70, "barcode_cache");
  const incoming = field(70, "plcb_spirits");
  const merged = mergeField(existing, incoming, "proof");
  assert.equal(merged.overwritten, false);
  assert.equal(merged.confirmed, true);
  assert.equal(merged.field.value, 70);
  assert.equal(merged.field.source, "barcode_cache");
  assert.equal(merged.field.confidence, CONFIDENCE.VERY_HIGH);
  assert.equal(merged.conflict, undefined);
  assert.equal(merged.field.contributors?.[0]?.source, "plcb_spirits");
  assert.equal(merged.field.contributors?.[0]?.role, "confirmation");
});

test("mergeField records conflict without overwriting stronger canonical value", () => {
  const existing = field(80, "barcode_cache");
  const incoming = field(86, "plcb_spirits");
  const merged = mergeField(existing, incoming, "proof");
  assert.equal(merged.overwritten, false);
  assert.equal(merged.field.value, 80);
  assert.equal(merged.field.source, "barcode_cache");
  assert.ok(merged.conflict);
  assert.equal(merged.field.contributors?.[0]?.role, "conflict");
  assert.equal(merged.field.contributors?.[0]?.value, 86);
});

test("Captain Morgan: government fills previously missing origin", async () => {
  await withCaptainGovDb(async () => {
    const candidate = barcodeCacheCandidate({ origin: null });
    const lookup = searchGovernmentByBarcode(CAPTAIN_UPC);
    assert.equal(lookup.status, "hit");
    const result = applyGovernmentCatalogEvidence(candidate, lookup, {
      lookupUpc: CAPTAIN_UPC
    });
    assert.equal(result.outcome, "hit_contributed");
    assert.ok(result.contributed.includes("origin"));
    assert.equal(candidate.origin.value, "United States");
    assert.equal(candidate.origin.source, "plcb_spirits");
    assert.equal(candidate.origin.confidence, CONFIDENCE.HIGH);
    assert.equal(candidate.origin.sourceItemId, CAPTAIN_ITEM);
    assert.equal(candidate.origin.matchedCode, CAPTAIN_UPC);
  });
});

test("Captain Morgan: government confirms barcode_cache proof without altering canonical", async () => {
  await withCaptainGovDb(async () => {
    const candidate = barcodeCacheCandidate({ proof: 70, origin: "United States" });
    const beforeProof = candidate.proof.confidence;
    const lookup = searchGovernmentByBarcode(CAPTAIN_UPC);
    const result = applyGovernmentCatalogEvidence(candidate, lookup, {
      lookupUpc: CAPTAIN_UPC
    });
    assert.equal(result.outcome, "hit_confirmed_existing");
    assert.ok(result.confirmed.includes("proof"));
    assert.ok(!result.contributed.includes("proof"));
    assert.equal(candidate.proof.value, 70);
    assert.equal(candidate.proof.source, "barcode_cache");
    assert.equal(candidate.proof.confidence, beforeProof);
    assert.equal(candidate.proof.confidence, CONFIDENCE.VERY_HIGH);
    const confirmation = candidate.proof.contributors?.find((c) => c.source === "plcb_spirits");
    assert.ok(confirmation);
    assert.equal(confirmation?.role, "confirmation");
    assert.equal(confirmation?.sourceItemId, CAPTAIN_ITEM);
    assert.equal(confirmation?.matchedCode, CAPTAIN_UPC);
    assert.notEqual(result.outcome, "hit_no_usable_fields");
  });
});

test("Captain Morgan: government confirms vault proof without altering canonical", async () => {
  await withCaptainGovDb(async () => {
    const candidate = vaultCandidate({ proof: 70 });
    const lookup = searchGovernmentByBarcode(CAPTAIN_UPC);
    const result = applyGovernmentCatalogEvidence(candidate, lookup, {
      lookupUpc: CAPTAIN_UPC
    });
    assert.ok(
      result.outcome === "hit_confirmed_existing" || result.outcome === "hit_contributed"
    );
    assert.ok(result.confirmed.includes("proof") || candidate.proof.source === "vault");
    assert.equal(candidate.proof.value, 70);
    assert.equal(candidate.proof.source, "vault");
    assert.equal(candidate.proof.confidence, CONFIDENCE.VERY_HIGH);
  });
});

test("Captain Morgan: government conflict with stronger proof is recorded", async () => {
  await withCaptainGovDb(async () => {
    const candidate = barcodeCacheCandidate({
      proof: 80,
      abv: 40,
      origin: "United States",
      volume_ml: 1750
    });
    // Pre-fill category so government only conflicts on proof.
    candidate.category = field("Rum", "barcode_cache");
    const conflicts = [];
    const lookup = searchGovernmentByBarcode(CAPTAIN_UPC);
    const result = applyGovernmentCatalogEvidence(candidate, lookup, {
      lookupUpc: CAPTAIN_UPC,
      targets: ["proof"],
      conflicts
    });
    assert.equal(result.outcome, "hit_conflict");
    assert.ok(result.conflicts.includes("proof"));
    assert.equal(candidate.proof.value, 80);
    assert.equal(candidate.proof.source, "barcode_cache");
    assert.ok(conflicts.some((c) => c.field === "proof"));
  });
});

test("Captain Morgan: metadata diagnostics use hit_confirmed_existing not catalog_no_usable_fields", async () => {
  await withCaptainGovDb(async () => {
    const candidate = barcodeCacheCandidate({ proof: 70, origin: "United States" });
    const plan = metadataPlan(candidate);
    const executed = await executeMetadataEnrichment(candidate, plan, {
      lookupByUpc: async () => ({
        source: "cache",
        upc: CAPTAIN_UPC,
        product: {
          upc: CAPTAIN_UPC,
          name: "Captain Morgan Original Spiced Rum",
          brand: "Captain Morgan",
          category: "Rum",
          abv: 35,
          proof: 70,
          volume_ml: 1750,
          origin: "United States",
          product_type: "spirit",
          image_url: null,
          notes: null,
          fill_level_percent: 100,
          bottle_count: 1
        }
      }),
      searchWebHits: async () => []
    });
    const govStage = executed.diagnostics.stages.find((s) => s.stage === "government_catalog");
    assert.ok(govStage);
    assert.equal(govStage?.reason, "hit_confirmed_existing");
    assert.ok((govStage?.confirmedCount ?? 0) >= 1);
    assert.notEqual(govStage?.reason, "hit_no_usable_fields");
    assert.notEqual(govStage?.reason, "catalog_no_usable_fields");
    assert.equal(executed.candidate.proof.value, 70);
    assert.equal(executed.candidate.proof.source, "barcode_cache");
  });
});

test("Captain Morgan: Keeper enrichment view shows PLCB confirmation; patron omits contributors", async () => {
  await withCaptainGovDb(async () => {
    cleanupCaptain();
    const row = insertCaptainSpirit({ origin: null });
    saveBarcodeCacheEntry({
      upc: CAPTAIN_UPC,
      name: "Captain Morgan Original Spiced Rum",
      brand: "Captain Morgan",
      category: "Rum",
      abv: 35,
      proof: 70,
      volume_ml: 1750,
      source: "imported"
    });

    const keeper = buildBottleEnrichmentView({
      entityType: "spirits",
      entityId: Number(row.id),
      includeDiagnostics: true
    });
    assert.ok(keeper);
    assert.equal(keeper!.metadata.proof.value, 70);
    assert.equal(keeper!.metadata.proof.source, "barcode_cache");
    assert.equal(keeper!.metadata.proof.sourceLabel, "Barcode cache");
    const confirmation = keeper!.metadata.proof.contributors?.find(
      (c) => c.source === "plcb_spirits" && c.role === "confirmation"
    );
    assert.ok(confirmation, "Keeper proof should show PLCB Spirits confirmation");
    assert.equal(confirmation?.sourceLabel, "PLCB Spirits");
    assert.equal(confirmation?.confidenceLabel, "High");
    assert.equal(confirmation?.sourceItemId, CAPTAIN_ITEM);
    assert.equal(confirmation?.matchedCode, CAPTAIN_UPC);

    // Origin contributed when missing
    assert.equal(keeper!.metadata.origin.value, "United States");
    assert.equal(keeper!.metadata.origin.source, "plcb_spirits");
    assert.equal(keeper!.metadata.origin.sourceLabel, "PLCB Spirits");

    // Notes unchanged (not cleaned in this PR)
    assert.match(String(keeper!.inventory.notes ?? ""), /Gov proof: 70/);
    assert.match(String(keeper!.inventory.notes ?? ""), /Source item: 000004766/);

    const patron = buildBottleEnrichmentView({
      entityType: "spirits",
      entityId: Number(row.id),
      includeDiagnostics: false
    });
    assert.ok(patron);
    assert.equal(patron!.metadata.proof.contributors, undefined);
    assert.equal(patron!.metadata.origin.contributors, undefined);
    // Patron still sees product facts, not contributor plumbing
    assert.equal(patron!.metadata.proof.value, 70);

    cleanupCaptain();
  });
});

test("government evidence logging stays bounded without catalog payloads", async () => {
  await withCaptainGovDb(async () => {
    const lines: Array<Record<string, unknown>> = [];
    const candidate = barcodeCacheCandidate();
    const lookup = searchGovernmentByBarcode(CAPTAIN_UPC);
    const result = applyGovernmentCatalogEvidence(candidate, lookup, {
      lookupUpc: CAPTAIN_UPC
    });
    logGovernmentEvidenceOutcome(
      {
        info(fields) {
          lines.push(fields);
        }
      },
      CAPTAIN_UPC,
      result
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.event, "government_catalog_lookup");
    assert.ok(
      lines[0]?.outcome === "hit_confirmed_existing" || lines[0]?.outcome === "hit_contributed"
    );
    assert.equal(lines[0]?.upc, CAPTAIN_UPC);
    assert.ok(!("raw" in lines[0]!));
    assert.ok(!("payload" in lines[0]!));
    assert.ok(!JSON.stringify(lines[0]).includes("Manufacturer SCC"));
  });
});

test("ambiguous government lookup outcome remains ambiguous", () => {
  const candidate = barcodeCacheCandidate();
  const result = applyGovernmentCatalogEvidence(candidate, {
    status: "ambiguous",
    candidates: [],
    winner: null
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(candidate.proof.source, "barcode_cache");
});

test("miss government lookup outcome remains miss", () => {
  const candidate = barcodeCacheCandidate();
  const result = applyGovernmentCatalogEvidence(candidate, {
    status: "miss",
    candidates: [],
    winner: null
  });
  assert.equal(result.outcome, "miss");
});
