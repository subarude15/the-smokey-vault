import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { saveBarcodeCacheEntry } from "../../barcode_cache.js";
import { saveToCache } from "../catalogs/cola-cache-store.js";
import { CONFIDENCE, field, type FieldConflict } from "../candidate/index.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  confidenceBandForScore,
  confidenceLabelForBand,
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  jobStatusLabel,
  jobsHaveActiveWork,
  markJobCompleted,
  sourceLabel,
  upsertProductContent,
  upsertProductImage,
  type EnrichmentJob,
  type JobView
} from "./index.js";

const UPC_PREFIX = "08024477";

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Buffalo Trace",
    brand: "Buffalo Trace Distillery",
    category: "Whiskey",
    abv: 45,
    volume_ml: 750,
    upc: `${UPC_PREFIX}0001`,
    image_url: null as string | null,
    notes: "Personal shelf note",
    tasting_notes: "User tasting note",
    ...overrides
  };
  const result = db
    .prepare(
      `
    INSERT INTO spirits (
      name, brand, category, abv, volume_ml, upc, image_url, notes, tasting_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      row.name,
      row.brand,
      row.category,
      row.abv,
      row.volume_ml,
      row.upc,
      row.image_url,
      row.notes,
      row.tasting_notes
    );
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${UPC_PREFIX}%' OR name LIKE 'EnrichView%'`).run();
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${UPC_PREFIX}%'`).run();
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '${UPC_PREFIX}%'`).run();
}

function jobStub(status: EnrichmentJob["status"]): EnrichmentJob {
  return {
    id: 1,
    entity_type: "spirits",
    entity_id: 1,
    upc: "",
    job_type: "metadata",
    status,
    attempts: 0,
    max_attempts: 3,
    available_at: "2020-01-01T00:00:00.000Z",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "2020-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    last_error: null
  };
}

function jobView(
  partial: Pick<JobView, "statusLabel"> & Partial<JobView>
): JobView {
  return {
    type: partial.type ?? "metadata",
    status: partial.status ?? "pending",
    statusLabel: partial.statusLabel,
    attempts: partial.attempts ?? 0,
    lastError: partial.lastError ?? null
  };
}

test("sourceLabel maps provenance sources to readable labels", () => {
  assert.equal(sourceLabel("vault"), "Vault");
  assert.equal(sourceLabel("barcode_cache"), "Barcode cache");
  assert.equal(sourceLabel("cola"), "COLA");
  assert.equal(sourceLabel("fwgs"), "FWGS");
  assert.equal(sourceLabel("vision"), "Vision");
  assert.equal(sourceLabel("web"), "Web");
  assert.equal(sourceLabel("llm"), "AI");
  assert.equal(sourceLabel("user"), "User");
  assert.equal(sourceLabel(null), "Unknown");
  assert.equal(sourceLabel(undefined), "Unknown");
});

test("confidenceBandForScore maps numeric scores to readable bands", () => {
  assert.equal(confidenceBandForScore(CONFIDENCE.VERY_HIGH), "very_high");
  assert.equal(confidenceLabelForBand("very_high"), "Very high");
  assert.equal(confidenceBandForScore(CONFIDENCE.HIGH), "high");
  assert.equal(confidenceLabelForBand("high"), "High");
  assert.equal(confidenceBandForScore(CONFIDENCE.MEDIUM), "medium");
  assert.equal(confidenceLabelForBand("medium"), "Medium");
  assert.equal(confidenceBandForScore(CONFIDENCE.LOW), "low");
  assert.equal(confidenceLabelForBand("low"), "Low");
  assert.equal(confidenceBandForScore(null), "none");
  assert.equal(confidenceBandForScore(undefined), "none");
});

test("jobStatusLabel maps job + content state to friendly labels", () => {
  assert.equal(jobStatusLabel(jobStub("pending")), "waiting");
  assert.equal(jobStatusLabel(jobStub("running")), "in_progress");
  assert.equal(jobStatusLabel(jobStub("failed")), "failed");
  assert.equal(jobStatusLabel(null), "not_started");
  assert.equal(jobStatusLabel(jobStub("completed"), { hasResult: false }), "no_result");
  assert.equal(jobStatusLabel(jobStub("completed"), { hasResult: true }), "complete");
  assert.equal(jobStatusLabel(jobStub("completed"), { partial: true }), "partial");
  assert.equal(jobStatusLabel(jobStub("completed")), "complete");
});

test("pending or running jobs trigger polling; terminal jobs stop it", () => {
  assert.equal(
    jobsHaveActiveWork([
      jobView({ statusLabel: "complete" }),
      jobView({ statusLabel: "failed" }),
      jobView({ statusLabel: "no_result" })
    ]),
    false
  );
  assert.equal(jobsHaveActiveWork([jobView({ statusLabel: "waiting" })]), true);
  assert.equal(jobsHaveActiveWork([jobView({ statusLabel: "in_progress" })]), true);
  assert.equal(
    jobsHaveActiveWork([
      jobView({ statusLabel: "complete" }),
      jobView({ statusLabel: "waiting" })
    ]),
    true
  );
});

test("buildBottleEnrichmentView returns combined inventory and enrichment state", () => {
  cleanup();
  const spirit = insertSpirit({ name: "EnrichView Combined", upc: `${UPC_PREFIX}1001` });
  const entityId = Number(spirit.id);

  enqueueMetadataJob({ entityType: "spirits", entityId, upc: String(spirit.upc) });
  enqueueTastingNotesJob({ entityType: "spirits", entityId, upc: String(spirit.upc) });
  enqueueImageJob({ entityType: "spirits", entityId, upc: String(spirit.upc) });

  upsertProductContent({
    entityType: "spirits",
    entityId,
    officialNotes: "Official caramel and oak notes.",
    officialSourceUrl: "https://producer.example/buffalo-trace",
    officialSourceType: "official",
    houseProfile: "A house profile for Buffalo Trace."
  });
  upsertProductImage({
    entityType: "spirits",
    entityId,
    url: "https://cdn.example/bottle.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/buffalo-trace",
    score: 88,
    verified: true
  });

  for (const row of db
    .prepare(`SELECT id FROM enrichment_jobs WHERE entity_type = 'spirits' AND entity_id = ?`)
    .all(entityId) as Array<{ id: number }>) {
    markJobCompleted(row.id);
  }

  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId });
  assert.ok(view);
  assert.equal(view!.entityType, "spirits");
  assert.equal(view!.entityId, entityId);
  assert.equal(view!.identity.name.value, "EnrichView Combined");
  assert.equal(view!.identity.name.sourceLabel, "Vault");
  assert.equal(view!.identity.name.confidenceLabel, "Very high");
  assert.equal(view!.metadata.abv.value, 45);
  assert.equal(view!.tastingNotes.official, "Official caramel and oak notes.");
  assert.equal(view!.tastingNotes.houseProfile, "A house profile for Buffalo Trace.");
  assert.equal(view!.tastingNotes.personal, "User tasting note");
  assert.equal(view!.image.displayUrl, "https://cdn.example/bottle.jpg");
  assert.equal(view!.image.sourceType, "official");
  assert.equal(view!.image.verified, true);
  assert.equal(view!.image.userPreferred, false);
  assert.equal(view!.enrichment.jobs.length, 3);
  assert.equal(view!.enrichment.jobs.find((j) => j.type === "tasting_notes")?.statusLabel, "complete");
  assert.equal(view!.enrichment.jobs.find((j) => j.type === "image")?.statusLabel, "complete");
  // Completed metadata job alone is not Complete when recommended gaps (origin/ttb/proof) remain.
  assert.notEqual(view!.enrichment.jobs.find((j) => j.type === "metadata")?.statusLabel, "complete");
  cleanup();
});

test("missing optional content is represented cleanly without failing the view", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "EnrichView Sparse",
    brand: "Unknown",
    upc: `${UPC_PREFIX}1002`,
    abv: 0,
    volume_ml: 0,
    notes: "",
    tasting_notes: ""
  });
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  });
  assert.ok(view);
  assert.equal(view!.tastingNotes.official, null);
  assert.equal(view!.tastingNotes.houseProfile, null);
  assert.equal(view!.tastingNotes.sourceUrl, null);
  assert.equal(view!.image.displayUrl, null);
  assert.equal(view!.image.score, null);
  assert.equal(view!.enrichment.jobs.length, 3);
  assert.ok(view!.enrichment.jobs.every((j) => j.statusLabel === "not_started"));
  assert.ok(Array.isArray(view!.enrichment.missing));
  assert.ok(view!.enrichment.missing.length > 0);
  cleanup();
});

test("null enrichment result displays no_result rather than failure", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "EnrichView Empty Result",
    upc: `${UPC_PREFIX}1003`,
    notes: null,
    tasting_notes: null
  });
  const entityId = Number(spirit.id);
  const tasting = enqueueTastingNotesJob({
    entityType: "spirits",
    entityId,
    upc: String(spirit.upc)
  });
  const image = enqueueImageJob({
    entityType: "spirits",
    entityId,
    upc: String(spirit.upc)
  });
  markJobCompleted(tasting.job.id);
  markJobCompleted(image.job.id);

  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId })!;
  const tastingJob = view.enrichment.jobs.find((j) => j.type === "tasting_notes");
  const imageJob = view.enrichment.jobs.find((j) => j.type === "image");
  assert.equal(tastingJob?.status, "completed");
  assert.equal(tastingJob?.statusLabel, "no_result");
  assert.equal(imageJob?.status, "completed");
  assert.equal(imageJob?.statusLabel, "no_result");
  cleanup();
});

test("user shelf image remains preferred over enriched external image", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "EnrichView User Image",
    upc: `${UPC_PREFIX}1004`,
    image_url: "/api/media/images/user-shelf.jpg",
    notes: null,
    tasting_notes: null
  });
  const entityId = Number(spirit.id);
  upsertProductImage({
    entityType: "spirits",
    entityId,
    url: "https://cdn.example/enriched.jpg",
    sourceType: "approved",
    sourceUrl: "https://shop.example/x",
    score: 90,
    verified: true
  });

  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId })!;
  assert.equal(view.image.displayUrl, "/api/media/images/user-shelf.jpg");
  assert.equal(view.image.sourceType, "user");
  assert.equal(view.image.userPreferred, true);
  assert.equal(view.image.enrichedUrl, "https://cdn.example/enriched.jpg");
  cleanup();
});

test("needsReview displays conflict information when vault and cache disagree", () => {
  cleanup();
  const upc = `${UPC_PREFIX}1005`;
  const spirit = insertSpirit({
    name: "Vault Name",
    brand: "Vault Brand",
    upc,
    notes: null,
    tasting_notes: null
  });
  saveToCache(
    {
      upc,
      name: "COLA Name",
      brand: "COLA Brand",
      category: "Whiskey",
      abv: 45,
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
  assert.equal(view.enrichment.needsReview, true);
  assert.ok(view.enrichment.conflicts.length >= 1);
  const nameConflict = view.enrichment.conflicts.find((c) => c.field === "name");
  assert.ok(nameConflict);
  assert.equal(nameConflict!.keptValue, "Vault Name");
  assert.equal(nameConflict!.competingValue, "COLA Name");
  assert.equal(nameConflict!.keptSourceLabel, "Vault");
  assert.equal(nameConflict!.competingSourceLabel, "COLA cache");
  cleanup();
});

test("injected conflicts still surface on the enrichment view", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "EnrichView Injected",
    upc: `${UPC_PREFIX}1006`,
    notes: null,
    tasting_notes: null
  });
  const conflict: FieldConflict = {
    field: "name",
    existing: field("Kept Name", "vault"),
    incoming: field("Other Name", "cola")
  };
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id),
    conflicts: [conflict]
  })!;
  assert.equal(view.enrichment.needsReview, true);
  assert.equal(view.enrichment.conflicts[0]?.keptValue, "Kept Name");
  assert.equal(view.enrichment.conflicts[0]?.competingValue, "Other Name");
  assert.equal(view.enrichment.conflicts[0]?.competingSourceLabel, "COLA");
  cleanup();
});

test("official tasting notes and house profile remain visibly distinct in the view", () => {
  cleanup();
  const spirit = insertSpirit({
    name: "EnrichView Notes",
    upc: `${UPC_PREFIX}1007`,
    notes: null,
    tasting_notes: null
  });
  const entityId = Number(spirit.id);
  upsertProductContent({
    entityType: "spirits",
    entityId,
    officialNotes: "Official producer copy.",
    officialSourceUrl: "https://producer.example/notes",
    officialSourceType: "official",
    houseProfile: "AI house profile copy."
  });

  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId })!;
  assert.equal(view.tastingNotes.official, "Official producer copy.");
  assert.equal(view.tastingNotes.houseProfile, "AI house profile copy.");
  assert.notEqual(view.tastingNotes.official, view.tastingNotes.houseProfile);
  assert.equal(view.tastingNotes.sourceType, "official");
  assert.ok(view.tastingNotes.sourceUrl?.includes("producer.example"));
  cleanup();
});

test("unknown module or missing item returns null from the view builder", () => {
  cleanup();
  assert.equal(buildBottleEnrichmentView({ entityType: "cocktails", entityId: 1 }), null);
  assert.equal(buildBottleEnrichmentView({ entityType: "spirits", entityId: 999999 }), null);
  cleanup();
});

test("inventory identity fields remain readable when barcode cache agrees", () => {
  cleanup();
  const upc = `${UPC_PREFIX}1008`;
  const spirit = insertSpirit({
    name: "EnrichView Cache Agree",
    brand: "Same Brand",
    upc,
    notes: null,
    tasting_notes: null
  });
  saveBarcodeCacheEntry({
    upc,
    name: "EnrichView Cache Agree",
    brand: "Same Brand",
    category: "Whiskey",
    abv: 45,
    proof: 90,
    volume_ml: 750,
    source: "fwgs"
  });
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  assert.equal(view.enrichment.needsReview, false);
  assert.equal(view.identity.name.value, "EnrichView Cache Agree");
  cleanup();
});
