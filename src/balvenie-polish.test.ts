/**
 * Balvenie polish regression: numeric validation, classification hierarchy,
 * canonical name conflict comparison, needsReview, enrichment eligibility.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeForCompare,
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalTaxonomy,
  stripPackageTokensFromName
} from "./canonical-normalize.js";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import { saveToCache } from "./ingestion/catalogs/cola-cache-store.js";
import { field, mergeField, valuesDisagree } from "./ingestion/candidate/index.js";
import { planEnrichment } from "./ingestion/enrichment/index.js";
import {
  buildBottleEnrichmentView,
  candidateFromInventoryRow,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  imageEnrichmentAvailability,
  markJobCompleted,
  queueEnrichmentBackfill,
  shouldScheduleMetadataEnrichment
} from "./ingestion/jobs/index.js";
import { db } from "./db.js";
import { CONFIDENCE } from "./ingestion/candidate/types.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const UPC = "083664871681";
const PREFIX = "08366487";

const BALVENIE_VAULT = {
  name: "Balvenie 14 Yr Carribbean",
  brand: "The Balvenie",
  product_type: "spirit",
  upc: UPC
};

const BALVENIE_CACHE = {
  name: "Balvenie 14 Yr Carribbean 750 Ml",
  category: "Food",
  type: "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey",
  abv: 0,
  proof: 0,
  volume_ml: 750
};

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
    name: BALVENIE_VAULT.name,
    brand: BALVENIE_VAULT.brand,
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
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;
}

test("ABV 0 from cache renders as missing", () => {
  cleanup();
  const spirit = insertBalvenie();
  saveBarcodeCacheEntry({
    upc: UPC,
    name: BALVENIE_CACHE.name,
    brand: BALVENIE_VAULT.brand,
    category: BALVENIE_CACHE.type,
    abv: 0,
    proof: 0,
    volume_ml: 750,
    source: "upcitemdb"
  });
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  assert.equal(view.metadata.abv.value, null);
  assert.equal(view.metadata.abv.status, "missing");
  assert.notEqual(view.metadata.abv.confidenceLabel, "Very high");
  cleanup();
});

test("proof 0 from cache renders as missing", () => {
  cleanup();
  const spirit = insertBalvenie();
  saveBarcodeCacheEntry({
    upc: UPC,
    name: BALVENIE_CACHE.name,
    brand: BALVENIE_VAULT.brand,
    category: "Whiskey",
    abv: 0,
    proof: 0,
    volume_ml: 750,
    source: "upcitemdb"
  });
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  assert.equal(view.metadata.proof.value, null);
  assert.equal(view.metadata.proof.status, "missing");
  cleanup();
});

test("valid ABV and proof remain unchanged", () => {
  assert.equal(normalizeCanonicalAbv(43), 43);
  assert.equal(normalizeCanonicalProof(86), 86);
  cleanup();
  const spirit = insertBalvenie({ abv: 43 });
  saveBarcodeCacheEntry({
    upc: UPC,
    name: BALVENIE_VAULT.name,
    brand: BALVENIE_VAULT.brand,
    category: "Whiskey",
    abv: 43,
    proof: 86,
    volume_ml: 750,
    source: "scan"
  });
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  assert.equal(view.metadata.abv.value, 43);
  assert.equal(view.metadata.proof.value, 86);
  cleanup();
});

test("package suffix difference does not create a name conflict", () => {
  assert.equal(
    valuesDisagree(
      "Balvenie 14 Yr Carribbean",
      "Balvenie 14 Yr Carribbean 750 Ml",
      "name"
    ),
    false
  );
  const merged = mergeField(
    field("Balvenie 14 Yr Carribbean", "vault"),
    field("Balvenie 14 Yr Carribbean 750 Ml", "barcode_cache"),
    "name"
  );
  assert.equal(merged.conflict, undefined);
});

test("case and whitespace-only differences do not create conflicts", () => {
  assert.equal(valuesDisagree("  The Balvenie ", "the balvenie", "brand"), false);
  assert.equal(
    canonicalizeForCompare("Balvenie 14 Yr Carribbean", "name"),
    canonicalizeForCompare("balvenie 14 yr carribbean", "name")
  );
});

test("genuine age difference still creates a conflict", () => {
  assert.equal(valuesDisagree("Balvenie 12 Year", "Balvenie 14 Year", "name"), true);
  const merged = mergeField(
    field("Balvenie 12 Year", "vault"),
    field("Balvenie 14 Year", "cola_cache"),
    "name"
  );
  assert.ok(merged.conflict);
});

test("genuine product-expression difference still creates a conflict", () => {
  assert.equal(
    valuesDisagree("Balvenie Caribbean Cask", "Balvenie DoubleWood", "name"),
    true
  );
});

test("false package conflict does not set needsReview", () => {
  cleanup();
  const spirit = insertBalvenie();
  saveToCache(
    {
      upc: UPC,
      name: BALVENIE_CACHE.name,
      brand: BALVENIE_VAULT.brand,
      category: BALVENIE_CACHE.type,
      abv: null,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: null,
      origin: null,
      approval_date: null
    },
    null,
    null,
    "cola_cloud"
  );
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  assert.equal(view.enrichment.needsReview, false);
  assert.equal(
    view.enrichment.conflicts.some((c) => c.field === "name"),
    false
  );
  cleanup();
});

test("spirit remains broad product_type; Whiskey preserved from taxonomy", () => {
  const tax = normalizeCanonicalTaxonomy("Food", BALVENIE_CACHE.type);
  assert.equal(tax.productType, "spirit");
  assert.equal(tax.family, "Whiskey");
  assert.equal(tax.type, "");
});

test("Scotch Whisky preserved when trusted evidence supports it", () => {
  const tax = normalizeCanonicalTaxonomy("Whiskey", "Scotch Whisky");
  assert.equal(tax.productType, "spirit");
  assert.equal(tax.family, "Whiskey");
  assert.equal(tax.type, "Scotch Whisky");
});

test("no Scotch subtype invented without evidence", () => {
  const tax = normalizeCanonicalTaxonomy("Food", BALVENIE_CACHE.type);
  assert.equal(tax.family, "Whiskey");
  assert.equal(tax.type, "");
  assert.ok(!/scotch/i.test(tax.type));
});

test("stronger Scotch Whisky is not downgraded to generic Whiskey", () => {
  const merged = mergeField(
    field("Scotch Whisky", "cola", CONFIDENCE.HIGH),
    field("Whiskey", "upcitemdb", CONFIDENCE.MEDIUM),
    "category"
  );
  assert.equal(merged.field.value, "Scotch Whisky");
  assert.equal(merged.conflict, undefined);
  assert.equal(merged.overwritten, false);
});

test("generic Whiskey may specialize to Scotch Whisky from trusted evidence", () => {
  const merged = mergeField(
    field("Whiskey", "vault", CONFIDENCE.VERY_HIGH),
    field("Scotch Whisky", "cola", CONFIDENCE.HIGH),
    "category"
  );
  assert.equal(merged.field.value, "Scotch Whisky");
  assert.equal(merged.overwritten, true);
});

test("Balvenie: missing ABV/proof eligible; classification from cache; no fake review", () => {
  cleanup();
  const spirit = insertBalvenie();
  saveBarcodeCacheEntry({
    upc: UPC,
    name: BALVENIE_CACHE.name,
    brand: BALVENIE_VAULT.brand,
    category: BALVENIE_CACHE.type,
    abv: 0,
    proof: 0,
    volume_ml: 750,
    source: "upcitemdb"
  });
  saveToCache(
    {
      upc: UPC,
      name: BALVENIE_CACHE.name,
      brand: BALVENIE_VAULT.brand,
      category: "Scotch Whisky",
      abv: null,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: null,
      origin: null,
      approval_date: null
    },
    null,
    null,
    "cola_cloud"
  );

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(spirit.id)) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(candidate.product_type.value, "spirit");
  assert.equal(candidate.abv.value, null);
  assert.equal(candidate.proof.value, null);
  assert.equal(candidate.volume_ml.value, 750);
  // Classification from trusted/cache path — not stuck at bare spirit with empty category.
  assert.ok(candidate.category.value);
  assert.ok(/whiskey|scotch/i.test(String(candidate.category.value)));

  const plan = planEnrichment(candidate);
  assert.equal(plan.needsReview, false);
  assert.ok(plan.tasks.some((t) => t.field === "abv"));
  assert.ok(plan.tasks.some((t) => t.field === "proof"));
  assert.equal(
    shouldScheduleMetadataEnrichment({
      candidate,
      entityType: "spirits",
      entityId: Number(spirit.id)
    }),
    true
  );

  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  assert.equal(view.enrichment.needsReview, false);
  assert.equal(view.metadata.abv.status, "missing");
  assert.equal(view.identity.productType.value, "spirit");
  cleanup();
});

test("completed image job with no accepted image remains no_result", () => {
  cleanup();
  const spirit = insertBalvenie({ abv: 45, category: "Whiskey" });
  const id = Number(spirit.id);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  markJobCompleted(enqueueImageJob({ entityType: "spirits", entityId: id, upc: UPC }).job.id);
  assert.equal(imageEnrichmentAvailability({ entityType: "spirits", entityId: id, row }), "no_result");
  cleanup();
});

test("no-result image is not automatically retried by ordinary backfill", () => {
  cleanup();
  const spirit = insertBalvenie({ abv: 45, category: "Whiskey", upc: `${PREFIX}0099` });
  const id = Number(spirit.id);
  markJobCompleted(
    enqueueImageJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0099` }).job.id
  );
  const result = queueEnrichmentBackfill({ types: ["image"] });
  assert.equal(result.queued.image, 0);
  cleanup();
});

test("package token strip does not invent Caribbean Cask rename", () => {
  assert.equal(
    stripPackageTokensFromName("Balvenie 14 Yr Carribbean 750 Ml"),
    "Balvenie 14 Yr Carribbean"
  );
});

test("SettingsPage wires transient notice auto-dismiss", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const appSrc = readFileSync(join(process.cwd(), "client/src/App.tsx"), "utf8");
  assert.ok(appSrc.includes('from "./useTransientNotice"'));
  assert.ok(appSrc.includes("useTransientNotice()"));
});

test("patron bottle detail and scan-session modules remain present", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const publicSrc = readFileSync(join(process.cwd(), "client/src/BottlePublicContent.tsx"), "utf8");
  const sessionSrc = readFileSync(join(process.cwd(), "client/src/ScanSession.tsx"), "utf8");
  assert.ok(publicSrc.includes("export function BottlePublicContent"));
  assert.ok(sessionSrc.includes("export function ScanSession") || sessionSrc.includes("function ScanSession"));
});
