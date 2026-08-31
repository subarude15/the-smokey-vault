/**
 * Canonical taxonomy / numeric normalization + Balvenie regression fixture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displayCanonicalFamily,
  displayCanonicalType,
  isCommerceTaxonomyJunk,
  isUsableCanonicalFamily,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  normalizeCanonicalVolumeMl,
  stripPackageTokensFromName
} from "./canonical-normalize.js";
import { spiritFamilyFromLabel } from "./catalog.js";
import { productToInventoryFields } from "./cola_client.js";
import {
  candidateFromInventoryRow,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  imageEnrichmentAvailability,
  markJobCompleted,
  metadataEnrichmentAvailability,
  previewEnrichmentBackfill,
  queueEnrichmentBackfill,
  tastingNotesEnrichmentAvailability,
  upsertProductContent,
  upsertProductImage
} from "./ingestion/jobs/index.js";
import { planEnrichment } from "./ingestion/enrichment/index.js";
import { saveToCache } from "./ingestion/catalogs/cola-cache-store.js";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import { db } from "./db.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const BALVENIE_FIXTURE = {
  name: "Balvenie 14 Yr Carribbean 750 Ml",
  brand: "The Balvenie",
  family: "Food",
  type: "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey",
  abv: 0,
  volume_ml: 750,
  upc: "083664871681"
};

const PREFIX = "08366487";

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(BALVENIE_FIXTURE.upc);
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(BALVENIE_FIXTURE.upc);
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(BALVENIE_FIXTURE.upc);
}

test("hierarchical liquor taxonomy normalizes to canonical spirit category", () => {
  const tax = normalizeCanonicalTaxonomy(
    "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey",
    ""
  );
  assert.equal(tax.family, "Whiskey");
  assert.equal(tax.productType, "spirit");
  assert.equal(tax.type, "");
  assert.ok(tax.wasCommerceTaxonomy);
});

test("Food does not survive as canonical bottle family", () => {
  const tax = normalizeCanonicalTaxonomy("Food", "");
  assert.equal(tax.family, "");
  assert.ok(tax.discardedJunk);
  assert.equal(spiritFamilyFromLabel("Food").family, "");
  assert.ok(isCommerceTaxonomyJunk("Food"));
  assert.equal(isUsableCanonicalFamily("Food"), false);
});

test("generic Beverages does not survive as bottle type", () => {
  const tax = normalizeCanonicalTaxonomy("Beverages", "");
  assert.equal(tax.family, "");
  assert.equal(tax.type, "");
  assert.equal(displayCanonicalType("Beverages"), "");
  assert.equal(displayCanonicalFamily("Beverages"), "");
});

test("valid existing canonical categories remain unchanged", () => {
  assert.deepEqual(spiritFamilyFromLabel("Bourbon"), { family: "Whiskey", type: "Bourbon" });
  assert.deepEqual(spiritFamilyFromLabel("Whiskey", "Rye"), { family: "Whiskey", type: "Rye" });
  assert.equal(spiritFamilyFromLabel("Gin").family, "Gin");
  assert.equal(spiritFamilyFromLabel("Mixer").family, "Mixer");
  assert.equal(normalizeCanonicalTaxonomy("Rum", "Dark").family, "Rum");
  assert.equal(normalizeCanonicalTaxonomy("Rum", "Dark").type, "Dark");
});

test("ABV 0 becomes unresolved for alcoholic bottle", () => {
  assert.equal(normalizeCanonicalAbv(0), null);
  assert.equal(normalizeCanonicalAbv(0, { productType: "spirit" }), null);
  assert.equal(normalizeCanonicalAbv(0, { productType: "mixer", allowZero: true }), 0);
});

test("negative and impossible ABV rejected", () => {
  assert.equal(normalizeCanonicalAbv(-1), null);
  assert.equal(normalizeCanonicalAbv(101), null);
  assert.equal(normalizeCanonicalAbv(Number.NaN), null);
  assert.equal(normalizeCanonicalAbv(45), 45);
});

test("proof 0 and impossible rejected", () => {
  assert.equal(normalizeCanonicalProof(0), null);
  assert.equal(normalizeCanonicalProof(-5), null);
  assert.equal(normalizeCanonicalProof(250), null);
  assert.equal(normalizeCanonicalProof(90), 90);
});

test("volume 0 and impossible rejected", () => {
  assert.equal(normalizeCanonicalVolumeMl(0), null);
  assert.equal(normalizeCanonicalVolumeMl(-10), null);
  assert.equal(normalizeCanonicalVolumeMl(50_000), null);
  assert.equal(normalizeCanonicalVolumeMl(750), 750);
});

test("Balvenie fixture: taxonomy, ABV, name, enrichment eligibility", () => {
  cleanup();
  const tax = normalizeCanonicalTaxonomy(BALVENIE_FIXTURE.family, BALVENIE_FIXTURE.type);
  assert.notEqual(tax.family, "Food");
  assert.ok(!String(tax.family).includes(">"));
  assert.ok(!String(tax.type).includes(">"));
  assert.equal(tax.family, "Whiskey");
  assert.equal(tax.productType, "spirit");
  // Do not invent Scotch / Single Malt from bare Whiskey leaf.
  assert.equal(tax.type, "");

  const fields = productToInventoryFields({
    upc: BALVENIE_FIXTURE.upc,
    name: BALVENIE_FIXTURE.name,
    brand: BALVENIE_FIXTURE.brand,
    category: BALVENIE_FIXTURE.type,
    abv: BALVENIE_FIXTURE.abv,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: BALVENIE_FIXTURE.volume_ml,
    product_type: null,
    ttb_id: null,
    origin: null,
    approval_date: null
  });
  assert.equal(fields.category, "Whiskey");
  assert.equal(fields.sub_category, "");
  assert.equal(fields.abv, null);
  assert.ok(!/750\s*ml/i.test(String(fields.name)));
  assert.match(String(fields.name), /Balvenie/i);
  // No speculative Caribbean Cask rewrite.
  assert.ok(!/Caribbean Cask/i.test(String(fields.name)));

  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, upc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    BALVENIE_FIXTURE.name,
    BALVENIE_FIXTURE.brand,
    BALVENIE_FIXTURE.family,
    BALVENIE_FIXTURE.type,
    BALVENIE_FIXTURE.abv,
    BALVENIE_FIXTURE.volume_ml,
    BALVENIE_FIXTURE.upc
  );
  const id = Number(result.lastInsertRowid);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(candidate.category.value, "Whiskey");
  assert.equal(candidate.abv.value, null);
  assert.ok(isUnresolvedFieldOrNull(candidate.abv));
  const plan = planEnrichment(candidate);
  assert.ok(plan.tasks.some((task) => task.field === "abv"));
  assert.equal(metadataEnrichmentAvailability({ candidate, entityType: "spirits", entityId: id }), "missing");
  assert.equal(displayCanonicalFamily(String(row.category)), "");
  assert.equal(displayCanonicalType(String(row.sub_category)), "");
  cleanup();
});

function isUnresolvedFieldOrNull(field: { value: unknown; confidence: number }) {
  return field.value == null || field.confidence === 0;
}

test("accepted image means complete availability", () => {
  cleanup();
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES ('Img Complete', 'Brand', 'Whiskey', 45, 750, ?, '')
  `).run(`${PREFIX}0001`);
  const id = Number(result.lastInsertRowid);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  upsertProductImage({
    entityType: "spirits",
    entityId: id,
    url: "https://cdn.example/ok.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/x",
    score: 90,
    verified: true
  });
  assert.equal(imageEnrichmentAvailability({ entityType: "spirits", entityId: id, row }), "complete");
  cleanup();
});

test("completed image job without accepted image is no_result not complete", () => {
  cleanup();
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES ('Img NoResult', 'Brand', 'Whiskey', 45, 750, ?, '')
  `).run(`${PREFIX}0002`);
  const id = Number(result.lastInsertRowid);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const job = enqueueImageJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0002` }).job;
  markJobCompleted(job.id);
  assert.equal(imageEnrichmentAvailability({ entityType: "spirits", entityId: id, row }), "no_result");
  assert.notEqual(imageEnrichmentAvailability({ entityType: "spirits", entityId: id, row }), "complete");
  cleanup();
});

test("no-result image is not automatically requeued", () => {
  cleanup();
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES ('Img NoRequeue', 'Brand', 'Whiskey', 45, 750, ?, '')
  `).run(`${PREFIX}0003`);
  const id = Number(result.lastInsertRowid);
  const job = enqueueImageJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0003` }).job;
  markJobCompleted(job.id);
  const queued = queueEnrichmentBackfill({ types: ["image"] });
  assert.equal(queued.queued.image, 0);
  cleanup();
});

test("tasting-note no_result status behaves correctly", () => {
  cleanup();
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc)
    VALUES ('Taste NoResult', 'Brand', 'Whiskey', 45, 750, ?)
  `).run(`${PREFIX}0004`);
  const id = Number(result.lastInsertRowid);
  assert.equal(tastingNotesEnrichmentAvailability({ entityType: "spirits", entityId: id }), "missing");
  const job = enqueueTastingNotesJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0004` }).job;
  markJobCompleted(job.id);
  assert.equal(tastingNotesEnrichmentAvailability({ entityType: "spirits", entityId: id }), "no_result");
  const queued = queueEnrichmentBackfill({ types: ["tasting_notes"] });
  assert.equal(queued.queued.tasting_notes, 0);
  cleanup();
});

test("maintenance preview counts actual complete vs no_result correctly", () => {
  cleanup();
  // Actually complete bottle — shelf + cache-only metadata + content + image
  const upcComplete = `${PREFIX}000005`;
  const complete = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES ('Preview Complete', 'Brand', 'Whiskey', 45, 750, ?, '')
  `).run(upcComplete);
  const completeId = Number(complete.lastInsertRowid);
  saveToCache(
    {
      upc: upcComplete,
      name: "Preview Complete",
      brand: "Brand",
      category: "Whiskey",
      abv: 45,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: "TTB-PC-1",
      origin: "Kentucky",
      approval_date: null
    },
    null,
    null,
    "cola_cloud"
  );
  saveBarcodeCacheEntry({
    upc: upcComplete,
    name: "Preview Complete",
    brand: "Brand",
    category: "Whiskey",
    abv: 45,
    proof: 90,
    volume_ml: 750,
    source: "enrichment"
  });
  upsertProductContent({
    entityType: "spirits",
    entityId: completeId,
    officialNotes: "Official.",
    officialSourceUrl: "https://producer.example/x",
    officialSourceType: "official",
    houseProfile: "House."
  });
  upsertProductImage({
    entityType: "spirits",
    entityId: completeId,
    url: "https://cdn.example/c.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/x",
    score: 91,
    verified: true
  });
  markJobCompleted(
    enqueueMetadataJob({ entityType: "spirits", entityId: completeId, upc: upcComplete }).job.id,
    {
      requested: ["category", "abv", "proof", "volume_ml", "origin", "ttb_id"],
      updated: ["abv", "proof", "origin", "ttb_id"],
      unresolved: []
    }
  );

  // No-result image + tasting (metadata filled)
  const noResult = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES ('Preview NoResult', 'Brand', 'Whiskey', 45, 750, ?, '')
  `).run(`${PREFIX}000006`);
  const noResultId = Number(noResult.lastInsertRowid);
  markJobCompleted(
    enqueueImageJob({ entityType: "spirits", entityId: noResultId, upc: `${PREFIX}000006` }).job.id
  );
  markJobCompleted(
    enqueueTastingNotesJob({ entityType: "spirits", entityId: noResultId, upc: `${PREFIX}000006` }).job.id
  );

  const preview = previewEnrichmentBackfill();
  assert.ok(preview.alreadyComplete >= 1);
  assert.ok(preview.noResultImages >= 1);
  assert.ok(preview.noResultTastingNotes >= 1);
  // No-result bottle must not inflate Already complete.
  const noResultRow = db.prepare("SELECT * FROM spirits WHERE id=?").get(noResultId) as Record<string, unknown>;
  assert.equal(
    imageEnrichmentAvailability({ entityType: "spirits", entityId: noResultId, row: noResultRow }),
    "no_result"
  );
  cleanup();
});

test("package size tokens stripped without speculative rename", () => {
  assert.equal(
    stripPackageTokensFromName("Balvenie 14 Yr Carribbean 750 Ml"),
    "Balvenie 14 Yr Carribbean"
  );
  assert.equal(stripPackageTokensFromName("Eagle Rare 10 Year"), "Eagle Rare 10 Year");
});

test("patron display helpers hide commerce taxonomy", () => {
  assert.equal(displayCanonicalFamily("Food"), "");
  assert.equal(
    displayCanonicalType("Food, Beverages & Tobacco > Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey"),
    ""
  );
  assert.equal(displayCanonicalFamily("Whiskey"), "Whiskey");
  assert.equal(displayCanonicalType("Scotch"), "Scotch");
});
