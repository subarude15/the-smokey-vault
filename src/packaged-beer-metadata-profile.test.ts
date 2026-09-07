import assert from "node:assert/strict";
import { test } from "node:test";
import { getBarcodeCacheEntry } from "./barcode_cache.js";
import { getBeerCacheEntry, saveBeerCacheEntry } from "./beer_cache.js";
import { db } from "./db.js";
import { metadataFieldsForEntityType } from "./ingestion/enrichment/metadata-fields.js";
import {
  candidateFromInventoryRow,
  persistMetadataImprovements
} from "./ingestion/jobs/inventory.js";
import {
  clearEnrichmentJobsForTests,
  enqueueMetadataJob,
  markJobCompleted
} from "./ingestion/jobs/store.js";
import {
  metadataOutcomeFromState,
  unresolvedMetadataFields
} from "./ingestion/jobs/metadata-outcome.js";
import { field } from "./ingestion/candidate/index.js";

const VALID_UPC = "089924788874";

function cleanup(): void {
  clearEnrichmentJobsForTests();
  db.prepare("DELETE FROM packaged_beer WHERE name LIKE 'PR113 %'").run();
  db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(VALID_UPC);
  db.prepare("DELETE FROM barcode_cache WHERE upc = ?").run(VALID_UPC);
  db.prepare("DELETE FROM cola_cache WHERE upc = ?").run(VALID_UPC);
}

function insertBeer(options: { style?: string; abv?: number; upc?: string } = {}) {
  const result = db.prepare(`
    INSERT INTO packaged_beer (brewery, name, style, abv, upc, count)
    VALUES ('Yuengling', 'PR113 Traditional Lager', ?, ?, ?, 1)
  `).run(options.style ?? "", options.abv ?? 0, options.upc ?? null);
  return Number(result.lastInsertRowid);
}

test("packaged beer core metadata is centralized as style/category plus ABV", () => {
  assert.deepEqual(metadataFieldsForEntityType("packaged_beer"), ["category", "abv"]);
  assert.deepEqual(metadataFieldsForEntityType("spirits"), [
    "category", "abv", "proof", "volume_ml", "origin", "ttb_id"
  ]);
  assert.deepEqual(metadataFieldsForEntityType("wines"), [
    "category", "abv", "proof", "volume_ml", "origin", "ttb_id"
  ]);
});

test("beer completeness ignores proof, generic volume, origin, and TTB ID", () => {
  cleanup();
  const entityId = insertBeer({ style: "American Amber Lager", abv: 4.5 });
  const row = db.prepare("SELECT * FROM packaged_beer WHERE id = ?").get(entityId) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("packaged_beer", row);

  assert.deepEqual(unresolvedMetadataFields(candidate, "packaged_beer"), []);
  assert.equal(
    metadataOutcomeFromState({ candidate, entityType: "packaged_beer", entityId }),
    "complete"
  );
  cleanup();
});

test("beer with ABV but missing style is Partial after a completed run", () => {
  cleanup();
  const entityId = insertBeer({ abv: 4.5 });
  const job = enqueueMetadataJob({ entityType: "packaged_beer", entityId }).job;
  markJobCompleted(job.id, {
    requested: ["category"],
    updated: [],
    unresolved: ["category"]
  });
  const row = db.prepare("SELECT * FROM packaged_beer WHERE id = ?").get(entityId) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("packaged_beer", row);

  assert.deepEqual(unresolvedMetadataFields(candidate, "packaged_beer"), ["category"]);
  assert.equal(
    metadataOutcomeFromState({ candidate, entityType: "packaged_beer", entityId }),
    "partial"
  );
  cleanup();
});

test("beer with neither style nor ABV is No result and lists only beer fields", () => {
  cleanup();
  const entityId = insertBeer();
  const job = enqueueMetadataJob({ entityType: "packaged_beer", entityId }).job;
  markJobCompleted(job.id, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });
  const row = db.prepare("SELECT * FROM packaged_beer WHERE id = ?").get(entityId) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("packaged_beer", row);

  assert.deepEqual(unresolvedMetadataFields(candidate, "packaged_beer"), ["category", "abv"]);
  assert.equal(
    metadataOutcomeFromState({ candidate, entityType: "packaged_beer", entityId }),
    "no_result"
  );
  cleanup();
});

test("packaged beer persistence uses beer cache without synthetic proof or 750 ml", () => {
  cleanup();
  const entityId = insertBeer({ style: "American Amber Lager", upc: VALID_UPC });
  const row = db.prepare("SELECT * FROM packaged_beer WHERE id = ?").get(entityId) as Record<string, unknown>;
  const before = candidateFromInventoryRow("packaged_beer", row);
  const after = {
    ...before,
    abv: field(4.5, "official_brewery")
  };

  const persisted = persistMetadataImprovements({
    entityType: "packaged_beer",
    entityId,
    before,
    after
  });

  assert.deepEqual(persisted.inventoryUpdated, ["abv"]);
  assert.equal(getBarcodeCacheEntry(VALID_UPC), null);
  const beer = getBeerCacheEntry(VALID_UPC, { allowStale: true });
  assert.equal(beer?.abv, 4.5);
  assert.equal(beer?.style, "American Amber Lager");
  cleanup();
});

test("beer cache rejects an invalid truncated GTIN instead of inventing digits", () => {
  cleanup();
  const saved = saveBeerCacheEntry({
    upc: "00899247",
    brewery: "Yuengling",
    name: "PR113 Traditional Lager",
    style: "American Amber Lager",
    abv: 4.5,
    source: "catalog_beer"
  });
  assert.equal(saved, null);
  const rows = db.prepare("SELECT upc FROM beer_cache WHERE name = 'PR113 Traditional Lager'").all();
  assert.deepEqual(rows, []);
  cleanup();
});
