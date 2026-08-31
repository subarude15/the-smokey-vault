/**
 * First-scan correctness: Gray Whale Gin classification, Mixer conflict rules,
 * lookup-image provenance, and enrichment loading/enqueue lifecycle.
 * Uses fakes only — no live SearXNG / Ollama / external image hosts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareSpiritWrite,
  reconcileSpiritClassificationForFirstSave,
  spiritFamilyFromLabel
} from "./catalog.js";
import { db } from "./db.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearProductImagesForTests,
  getProductImage,
  inventoryHasUserImage,
  maybeEnqueueImageEnrichment,
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  recordLookupImageFallback,
  upsertProductImage
} from "./ingestion/jobs/index.js";

const PREFIX = "86160200";
const GRAY_WHALE_UPC = "861602000412";

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(GRAY_WHALE_UPC);
  db.prepare(`DELETE FROM spirits WHERE name LIKE 'FirstScan%'`).run();
}

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "FirstScan Spirit",
    brand: "FirstScan Brand",
    category: "Gin",
    sub_category: "",
    abv: 40,
    volume_ml: 750,
    upc: `${PREFIX}0099`,
    image_url: "",
    ...overrides
  };
  const prepared = prepareSpiritWrite(row);
  const result = db
    .prepare(
      `
    INSERT INTO spirits (
      name, brand, category, sub_category, abv, volume_ml, upc, image_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      prepared.name,
      prepared.brand ?? "",
      prepared.category,
      prepared.sub_category ?? "",
      prepared.abv ?? 0,
      prepared.volume_ml ?? 750,
      prepared.upc ?? "",
      prepared.image_url ?? ""
    );
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

test("Gray Whale Gin cannot persist as Mixer from weaker conflicting category", () => {
  cleanup();
  const reconciled = reconcileSpiritClassificationForFirstSave({
    name: "Gray Whale Gin",
    category: "Mixer",
    productType: "spirit"
  });
  assert.equal(reconciled.family, "Gin");
  assert.notEqual(reconciled.family, "Mixer");

  const saved = prepareSpiritWrite({
    name: "Gray Whale Gin",
    category: "Mixer",
    product_type: "spirit",
    volume_ml: 750,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  assert.equal(saved.category, "Gin");
});

test("Mixer remains valid for a genuine mixer product", () => {
  const reconciled = reconcileSpiritClassificationForFirstSave({
    name: "Fever-Tree Tonic Water",
    category: "Mixer",
    productType: "mixer"
  });
  assert.equal(reconciled.family, "Mixer");

  const saved = prepareSpiritWrite({
    name: "Fever-Tree Tonic Water",
    category: "Mixer",
    product_type: "mixer"
  });
  assert.equal(saved.category, "Mixer");
});

test("Gin canonical family persists on first save via prepareSpiritWrite", () => {
  cleanup();
  const saved = prepareSpiritWrite({
    name: "Gray Whale Gin",
    brand: "Gray Whale",
    category: "",
    product_type: "spirit",
    volume_ml: 750,
    upc: GRAY_WHALE_UPC
  });
  assert.equal(saved.category, "Gin");

  const row = insertSpirit({
    name: "Gray Whale Gin",
    brand: "Gray Whale",
    category: "Mixer",
    upc: GRAY_WHALE_UPC,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  assert.equal(row.category, "Gin");
  cleanup();
});

test("Bourbon and Scotch existing normalization remain unchanged", () => {
  assert.deepEqual(spiritFamilyFromLabel("Bourbon"), { family: "Whiskey", type: "Bourbon" });
  assert.deepEqual(spiritFamilyFromLabel("Whiskey", "Bourbon"), { family: "Whiskey", type: "Bourbon" });

  const scotch = spiritFamilyFromLabel("Scotch Whisky");
  assert.equal(scotch.family, "Whiskey");
  assert.match(scotch.type, /Scotch/i);

  const balvenie = prepareSpiritWrite({
    name: "The Balvenie Caribbean Cask 14 Year Old",
    category: "Whiskey",
    sub_category: "Scotch Whisky"
  });
  assert.equal(balvenie.category, "Whiskey");
  assert.match(String(balvenie.sub_category), /Scotch/i);

  const woodford = prepareSpiritWrite({
    name: "Woodford Reserve Double Oaked",
    category: "Whiskey",
    sub_category: "Bourbon"
  });
  assert.equal(woodford.category, "Whiskey");
  assert.equal(woodford.sub_category, "Bourbon");

  const balvenieKeep = reconcileSpiritClassificationForFirstSave({
    name: "The Balvenie Caribbean Cask 14 Year Old",
    category: "Whiskey",
    subCategory: "Scotch Whisky"
  });
  assert.equal(balvenieKeep.family, "Whiskey");
  assert.match(balvenieKeep.type, /Scotch/i);

  const woodfordKeep = reconcileSpiritClassificationForFirstSave({
    name: "Woodford Reserve Double Oaked",
    category: "Whiskey",
    subCategory: "Bourbon"
  });
  assert.equal(woodfordKeep.family, "Whiskey");
  assert.equal(woodfordKeep.type, "Bourbon");
});

test("new identified product evaluates metadata/tasting/image enqueue independently", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    brand: "Gray Whale",
    category: "Mixer",
    upc: `${PREFIX}0412`,
    abv: 0,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  assert.equal(spirit.category, "Gin");

  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: String(spirit.image_url)
  });

  const meta = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const tasting = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const image = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });

  assert.ok(!( "reason" in meta && meta.reason === "unsupported_entity"));
  assert.ok(!( "reason" in tasting && tasting.reason === "unsupported_entity"));
  assert.equal(image.enqueued, true, `image enqueue failed: ${"reason" in image ? image.reason : ""}`);
  assert.equal(inventoryHasUserImage(spirit, "spirits", Number(spirit.id)), false);
  cleanup();
});

test("new bottle enrichment view returns resolved (non-hanging) state", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    upc: `${PREFIX}0413`,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: String(spirit.image_url)
  });

  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    includeDiagnostics: true
  });
  assert.ok(view);
  assert.ok(Array.isArray(view!.enrichment.jobs));
  assert.equal(view!.enrichment.jobs.length, 3);
  for (const job of view!.enrichment.jobs) {
    assert.ok(job.statusLabel);
    assert.equal(typeof job.statusLabel, "string");
  }
  cleanup();
});

test("missing jobs render resolved pending/empty semantics (not infinite loading)", () => {
  cleanup();
  const spirit = insertSpirit({ name: "FirstScan NoJobs", upc: `${PREFIX}0414` });
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  });
  assert.ok(view);
  const labels = view!.enrichment.jobs.map((j) => j.statusLabel);
  assert.equal(labels.length, 3);
  assert.ok(
    labels.every((l) =>
      l === "not_started" || l === "no_result" || l === "complete" || l === "partial" || l === "waiting"
    )
  );
  cleanup();
});

test("immediate lookup image is modeled as lookup fallback — not verified/official", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    upc: `${PREFIX}0415`,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: String(spirit.image_url)
  });

  const stored = getProductImage("spirits", Number(spirit.id));
  assert.ok(stored);
  assert.equal(stored!.source_type, "lookup");
  assert.equal(stored!.verified, false);

  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    includeDiagnostics: true
  });
  assert.ok(view);
  assert.equal(view!.image.sourceType, "lookup");
  assert.equal(view!.image.verified, false);
  assert.equal(view!.image.userPreferred, false);
  assert.ok(view!.image.displayUrl);
  cleanup();
});

test("verified enriched image outranks lookup fallback; user outranks verified", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    upc: `${PREFIX}0416`,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: String(spirit.image_url)
  });

  upsertProductImage({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: "https://cdn.graywhale.com/official.jpg",
    sourceType: "official",
    sourceUrl: "https://www.graywhale.com/products/gin",
    score: 90,
    verified: true
  });

  const enriched = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    includeDiagnostics: true
  });
  assert.ok(enriched);
  assert.equal(enriched!.image.displayUrl, "https://cdn.graywhale.com/official.jpg");
  assert.equal(enriched!.image.sourceType, "official");
  assert.equal(enriched!.image.verified, true);
  assert.equal(enriched!.image.userPreferred, false);

  db.prepare("UPDATE spirits SET image_url=? WHERE id=?").run(
    "/api/media/images/user-shelf-gray.jpg",
    spirit.id
  );
  upsertProductImage({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: "/api/media/images/user-shelf-gray.jpg",
    sourceType: "user",
    verified: true,
    score: null
  });
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(spirit.id) as Record<string, unknown>;
  assert.equal(inventoryHasUserImage(row, "spirits", Number(spirit.id)), true);

  const userView = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    includeDiagnostics: true
  });
  assert.ok(userView);
  assert.equal(userView!.image.displayUrl, "/api/media/images/user-shelf-gray.jpg");
  assert.equal(userView!.image.sourceType, "user");
  assert.equal(userView!.image.userPreferred, true);
  assert.equal(userView!.image.verified, true);
  cleanup();
});

test("same fallback URL may upgrade only through trusted provenance upsert", () => {
  cleanup();
  const url = "https://cdn.graywhale.com/shared.jpg";
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    upc: `${PREFIX}0417`,
    image_url: url
  });
  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url
  });
  let stored = getProductImage("spirits", Number(spirit.id));
  assert.equal(stored!.source_type, "lookup");
  assert.equal(stored!.verified, false);

  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url
  });
  stored = getProductImage("spirits", Number(spirit.id));
  assert.equal(stored!.source_type, "lookup");
  assert.equal(stored!.verified, false);

  upsertProductImage({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url,
    sourceType: "official",
    sourceUrl: "https://www.graywhale.com/gin",
    score: 88,
    verified: true
  });
  stored = getProductImage("spirits", Number(spirit.id));
  assert.equal(stored!.source_type, "official");
  assert.equal(stored!.verified, true);
  cleanup();
});

test("patrons still see images; keeper view exposes provenance", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    upc: `${PREFIX}0418`,
    image_url: "https://example-cdn.test/gray-whale.jpg"
  });
  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: String(spirit.image_url)
  });

  const keeper = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    includeDiagnostics: true
  });
  const patron = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    includeDiagnostics: false
  });
  assert.ok(keeper);
  assert.ok(patron);
  assert.ok(keeper!.image.displayUrl);
  assert.ok(patron!.image.displayUrl);
  assert.equal(keeper!.image.sourceType, "lookup");
  assert.equal(keeper!.image.verified, false);
  const patronDiag = patron!.enrichment.jobs.some((j) => j.diagnostics != null);
  assert.equal(patronDiag, false);
  cleanup();
});

test("scan/add path returns without waiting for enrichment", () => {
  cleanup();
  const started = Date.now();
  const spirit = insertSpirit({
    name: "Gray Whale Gin",
    upc: `${PREFIX}0419`,
    category: "Mixer",
    image_url: "https://example-cdn.test/gray-whale.jpg",
    abv: 0
  });
  recordLookupImageFallback({
    entityType: "spirits",
    entityId: Number(spirit.id),
    url: String(spirit.image_url)
  });
  maybeEnqueueMetadataEnrichment({ entityType: "spirits", entityId: Number(spirit.id), row: spirit });
  maybeEnqueueTastingNotesEnrichment({ entityType: "spirits", entityId: Number(spirit.id), row: spirit });
  maybeEnqueueImageEnrichment({ entityType: "spirits", entityId: Number(spirit.id), row: spirit });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `enqueue path blocked too long: ${elapsed}ms`);
  assert.equal(spirit.category, "Gin");
  cleanup();
});
