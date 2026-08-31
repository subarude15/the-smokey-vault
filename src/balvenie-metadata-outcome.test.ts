/**
 * Metadata outcome semantics + Balvenie (UPC 083664871681) regression.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { normalizeCanonicalTaxonomy } from "./canonical-normalize.js";
import { parseExtracted } from "./ingestion/enrichment/metadata-extract.js";
import {
  executeMetadataEnrichment,
  metadataSearchQuery,
  buildMetadataSearchQueries,
  planEnrichment,
  proofFromAbv
} from "./ingestion/enrichment/index.js";
import {
  buildBottleEnrichmentView,
  candidateFromInventoryRow,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  enqueueMetadataJob,
  imageEnrichmentAvailability,
  markJobCompleted,
  maybeEnqueueMetadataEnrichment,
  metadataEnrichmentAvailability,
  metadataOutcomeFromState,
  persistMetadataImprovements,
  previewEnrichmentBackfill,
  queueEnrichmentBackfill,
  shouldScheduleMetadataEnrichment
} from "./ingestion/jobs/index.js";
import { saveToCache } from "./ingestion/catalogs/cola-cache-store.js";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import { candidateFromProduct } from "./ingestion/candidate/index.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const UPC = "083664871681";
const PREFIX = "08366487";

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
}

function insertBalvenie(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Balvenie 14 Yr Carribbean",
    brand: "The Balvenie",
    category: "",
    sub_category: "",
    abv: 0,
    volume_ml: 750,
    upc: UPC,
    image_url: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, upc, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    row.brand,
    row.category,
    row.sub_category,
    row.abv,
    row.volume_ml,
    row.upc,
    row.image_url
  );
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(result.lastInsertRowid)) as Record<
    string,
    unknown
  >;
}

function metaJobLabel(entityId: number) {
  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId })!;
  return view.enrichment.jobs.find((j) => j.type === "metadata")?.statusLabel;
}

test("1. completed metadata + all recommended fields satisfied = Complete", () => {
  cleanup();
  const spirit = insertBalvenie({
    category: "Whiskey",
    sub_category: "Scotch Whisky",
    abv: 43
  });
  const id = Number(spirit.id);
  saveToCache(
    {
      upc: UPC,
      name: String(spirit.name),
      brand: String(spirit.brand),
      category: "Scotch Whisky",
      abv: 43,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: "TTB-BAL-1",
      origin: "Scotland",
      approval_date: null,
      proof: 86
    } as never,
    null,
    null,
    "cola_cloud"
  );
  // barcode_cache carries proof for overlay
  saveBarcodeCacheEntry({
    upc: UPC,
    name: String(spirit.name),
    brand: String(spirit.brand),
    category: "Whiskey",
    abv: 43,
    proof: 86,
    volume_ml: 750,
    source: "enrichment"
  });

  const job = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  markJobCompleted(job.id, {
    requested: ["category", "abv", "proof", "volume_ml", "origin", "ttb_id"],
    updated: ["category", "abv", "proof", "origin", "ttb_id"],
    unresolved: []
  });

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(metadataOutcomeFromState({ candidate, entityType: "spirits", entityId: id }), "complete");
  assert.equal(metadataEnrichmentAvailability({ candidate, entityType: "spirits", entityId: id }), "complete");
  assert.equal(metaJobLabel(id), "complete");
  cleanup();
});

test("2. completed metadata + zero accepted updates + gaps = No result", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  const job = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  markJobCompleted(job.id, {
    requested: ["category", "abv", "proof", "origin", "ttb_id"],
    updated: [],
    unresolved: ["category", "abv", "proof", "origin", "ttb_id"]
  });

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(metadataOutcomeFromState({ candidate, entityType: "spirits", entityId: id }), "no_result");
  assert.equal(metadataEnrichmentAvailability({ candidate, entityType: "spirits", entityId: id }), "no_result");
  assert.equal(metaJobLabel(id), "no_result");
  assert.ok(buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!.enrichment.missing.length > 0);
  cleanup();
});

test("3. completed metadata + some updates + gaps = Partial", () => {
  cleanup();
  const spirit = insertBalvenie({ category: "Whiskey", abv: 43 });
  const id = Number(spirit.id);
  const job = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  markJobCompleted(job.id, {
    requested: ["category", "abv", "proof", "origin", "ttb_id"],
    updated: ["category", "abv"],
    unresolved: ["proof", "origin", "ttb_id"]
  });

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(metadataOutcomeFromState({ candidate, entityType: "spirits", entityId: id }), "partial");
  assert.equal(metadataEnrichmentAvailability({ candidate, entityType: "spirits", entityId: id }), "partial");
  assert.equal(metaJobLabel(id), "partial");
  cleanup();
});

test("4. failed metadata job = Failed", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  const job = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  db.prepare(`UPDATE enrichment_jobs SET status = 'failed', last_error = 'boom' WHERE id = ?`).run(job.id);

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(metadataOutcomeFromState({ candidate, entityType: "spirits", entityId: id }), "failed");
  assert.equal(metaJobLabel(id), "failed");
  cleanup();
});

test("5. active metadata job = In progress / waiting", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC });
  assert.equal(metaJobLabel(id), "waiting");

  db.prepare(`
    UPDATE enrichment_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE entity_type = 'spirits' AND entity_id = ? AND job_type = 'metadata'
  `).run(id);
  assert.equal(metaJobLabel(id), "in_progress");
  cleanup();
});

test("6. bottle detail and maintenance use consistent completeness logic", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  const job = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  markJobCompleted(job.id, { requested: ["category", "abv"], updated: [], unresolved: ["category", "abv"] });

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  const avail = metadataEnrichmentAvailability({ candidate, entityType: "spirits", entityId: id });
  const label = metaJobLabel(id);
  assert.equal(avail, "no_result");
  assert.equal(label, "no_result");

  const preview = previewEnrichmentBackfill();
  assert.ok(preview.metadata >= 1, "maintenance must count unresolved metadata as queueable");
  assert.ok((preview.noResultMetadata ?? 0) >= 1);
  assert.notEqual(avail, "complete");
  cleanup();
});

test("7. missing category is metadata-enrichment eligible", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  const candidate = candidateFromInventoryRow("spirits", spirit);
  const plan = planEnrichment(candidate);
  assert.ok(plan.tasks.some((t) => t.field === "category"));
  assert.equal(
    shouldScheduleMetadataEnrichment({ candidate, entityType: "spirits", entityId: id }),
    true
  );
  cleanup();
});

test("8-9. trusted Whiskey / Scotch Whisky evidence fills canonical classification", async () => {
  cleanup();
  const spirit = insertBalvenie();
  const candidate = candidateFromInventoryRow("spirits", spirit);
  const plan = planEnrichment(candidate);

  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWeb: async () => "The Balvenie Caribbean Cask is a Scotch Whisky at 43% ABV.",
    extractMetadata: async () => ({
      category: "Scotch Whisky",
      abv: 43,
      proof: null,
      origin: null,
      ttb_id: null
    })
  });

  assert.equal(result.candidate.category.value, "Scotch Whisky");
  assert.equal(result.candidate.product_type.value, "spirit");
  assert.equal(result.candidate.abv.value, 43);
  assert.equal(result.candidate.proof.value, proofFromAbv(43));
  assert.ok(result.updated.includes("category"));
  assert.ok(result.updated.includes("abv"));
  assert.ok(result.updated.includes("proof"));

  const persisted = persistMetadataImprovements({
    entityType: "spirits",
    entityId: Number(spirit.id),
    before: candidate,
    after: result.candidate
  });
  assert.ok(persisted.inventoryUpdated.includes("category"));
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(spirit.id)) as Record<
    string,
    unknown
  >;
  assert.equal(row.category, "Whiskey");
  assert.equal(row.sub_category, "Scotch Whisky");
  assert.equal(row.abv, 43);
  assert.equal(row.product_type ?? "spirit", "spirit");
  cleanup();
});

test("10. Scotch is not inferred from brand alone", async () => {
  cleanup();
  const spirit = insertBalvenie();
  const candidate = candidateFromInventoryRow("spirits", spirit);
  const plan = planEnrichment(candidate);

  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWeb: async () => "The Balvenie is a famous Speyside distillery brand.",
    extractMetadata: async () => ({
      category: null,
      abv: null,
      proof: null,
      origin: null,
      ttb_id: null
    })
  });

  assert.equal(result.candidate.category.value, null);
  assert.ok(!/scotch/i.test(String(result.candidate.category.value ?? "")));
  cleanup();
});

test("11. raw ecommerce taxonomy never persists", () => {
  const tax = normalizeCanonicalTaxonomy(
    "Food",
    "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey"
  );
  assert.equal(tax.family, "Whiskey");
  assert.ok(!/food|beverage/i.test(tax.family));

  const parsed = parseExtracted(
    JSON.stringify({ category: "Food, Beverages & Tobacco > Beverages" }),
    ["category"]
  );
  assert.equal(parsed.category, null);
  cleanup();
});

test("12-14. ABV accepted, proof derives, invalid zero remains missing", async () => {
  cleanup();
  const spirit = insertBalvenie();
  const candidate = candidateFromInventoryRow("spirits", spirit);
  assert.equal(candidate.abv.value, null);
  assert.equal(candidate.proof.value, null);

  const plan = planEnrichment(candidate);
  const filled = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({
      source: "cola_cloud",
      upc: UPC,
      table: "spirits",
      kind: "spirits",
      product: {
        upc: UPC,
        name: "Balvenie 14 Yr Carribbean",
        brand: "The Balvenie",
        abv: 43,
        product_type: "spirit",
        category: "Whiskey"
      }
    }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });
  assert.equal(filled.candidate.abv.value, 43);
  assert.equal(filled.candidate.proof.value, 86);

  const zero = candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      category: "",
      abv: 0,
      proof: 0,
      volume_ml: 750
    },
    "vault"
  );
  assert.equal(zero.abv.value, null);
  assert.equal(zero.proof.value, null);
  cleanup();
});

test("15-16. explicit admin force can retry unresolved metadata; auto path does not loop", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  const job = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  markJobCompleted(job.id, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);

  assert.equal(
    shouldScheduleMetadataEnrichment({ candidate, entityType: "spirits", entityId: id }),
    false,
    "automatic path must not requeue after completed job"
  );
  assert.equal(
    shouldScheduleMetadataEnrichment({ candidate, entityType: "spirits", entityId: id, force: true }),
    true,
    "admin force may requeue when gaps remain"
  );

  const auto = maybeEnqueueMetadataEnrichment({ entityType: "spirits", entityId: id, row });
  assert.equal(auto.enqueued, false);

  const forced = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: id,
    row,
    force: true
  });
  assert.equal(forced.enqueued, true);
  assert.equal(forced.created, true);

  // Second auto ensure still no loop (active job already pending).
  const again = maybeEnqueueMetadataEnrichment({ entityType: "spirits", entityId: id, row });
  assert.equal(again.enqueued, false);

  const queued = queueEnrichmentBackfill({ types: ["metadata"] });
  // Already has active pending from force — should not duplicate endlessly.
  assert.ok(queued.queued.metadata <= 1);
  cleanup();
});

test("17. image no-result behavior remains unchanged", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  const job = enqueueImageJob({ entityType: "spirits", entityId: id, upc: UPC }).job;
  markJobCompleted(job.id);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(imageEnrichmentAvailability({ entityType: "spirits", entityId: id, row }), "no_result");
  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!;
  assert.equal(view.enrichment.jobs.find((j) => j.type === "image")?.statusLabel, "no_result");
  const queued = queueEnrichmentBackfill({ types: ["image"] });
  assert.equal(queued.queued.image, 0);
  cleanup();
});

test("metadata search query uses trusted identity fields", () => {
  const candidate = candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      category: null,
      abv: null,
      volume_ml: 750
    },
    "vault"
  );
  const queries = buildMetadataSearchQueries(candidate, ["category", "abv", "proof"]);
  assert.ok(queries.some((q) => /Balvenie/i.test(q)));
  assert.ok(queries.some((q) => /083664871681/.test(q)));
  assert.ok(queries.some((q) => /ABV/i.test(q)));
  assert.ok(queries.every((q) => !/invented/i.test(q)));
  // Progressive search must not exact-quote the entire stored name by default.
  assert.ok(queries.every((q) => !q.includes('"Balvenie 14 Yr Carribbean"')));
  assert.match(metadataSearchQuery(candidate, ["category", "abv", "proof"]), /Balvenie/);
});


test("Whiskey-only evidence leaves sub_category empty on persist", async () => {
  cleanup();
  const spirit = insertBalvenie();
  const candidate = candidateFromInventoryRow("spirits", spirit);
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWeb: async () => "A fine Whiskey bottled at 40% ABV.",
    extractMetadata: async () => ({ category: "Whiskey", abv: 40 })
  });
  persistMetadataImprovements({
    entityType: "spirits",
    entityId: Number(spirit.id),
    before: candidate,
    after: result.candidate
  });
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(spirit.id)) as Record<
    string,
    unknown
  >;
  assert.equal(row.category, "Whiskey");
  assert.equal(String(row.sub_category ?? ""), "");
  cleanup();
});

test("legacy completed job without result_json + gaps is no_result not Complete", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  markJobCompleted(enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job.id);
  assert.equal(metaJobLabel(id), "no_result");
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(
    metadataEnrichmentAvailability({
      candidate: candidateFromInventoryRow("spirits", row),
      entityType: "spirits",
      entityId: id
    }),
    "no_result"
  );
  cleanup();
});
