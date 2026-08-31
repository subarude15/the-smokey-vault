import assert from "node:assert/strict";
import { test } from "node:test";
import { saveToCache } from "../catalogs/cola-cache-store.js";
import { CONFIDENCE, field, mergeField } from "../candidate/index.js";
import { db } from "../../db.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearFieldOverridesForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  clearReviewAuditForTests,
  enqueueMetadataJob,
  getFieldOverride,
  listReviewAudit,
  markJobCompleted,
  markJobFailedOrRetry,
  claimNextPendingJob,
  resolveFieldConflict,
  rerunEnrichmentJob,
  upsertProductContent,
  verifyEnrichmentField,
  candidateWithOverrides,
  getProductContent
} from "./index.js";

const UPC = "080244660001";

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Vault Name",
    brand: "Vault Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc: UPC,
    notes: "",
    tasting_notes: "",
    ...overrides
  };
  const result = db
    .prepare(
      `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.name,
      row.brand,
      row.category,
      row.abv,
      row.volume_ml,
      row.upc,
      row.notes,
      row.tasting_notes
    );
  return Number(result.lastInsertRowid);
}

function seedConflict(id: number) {
  saveToCache(
    {
      upc: UPC,
      name: "COLA Name",
      brand: "COLA Brand",
      category: "Bourbon",
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
  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!;
  assert.equal(view.enrichment.needsReview, true);
  assert.ok(view.enrichment.conflicts.some((c) => c.field === "name"));
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearFieldOverridesForTests();
  clearReviewAuditForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '08024466%'`).run();
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '08024466%'`).run();
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '08024466%'`).run();
}

test("admin can keep the current conflict value as user/VERY_HIGH", () => {
  cleanup();
  const id = insertSpirit();
  seedConflict(id);
  const result = resolveFieldConflict({
    entityType: "spirits",
    entityId: id,
    field: "name",
    choice: "keep"
  });
  assert.equal(result.value, "Vault Name");
  assert.equal(result.source, "user");
  assert.equal(result.confidence, CONFIDENCE.VERY_HIGH);
  assert.equal(result.view?.enrichment.conflicts.some((c) => c.field === "name"), false);
  assert.ok(result.view?.verifiedFields?.includes("name"));
  assert.equal(result.view?.identity.name.sourceLabel, "User");
  const override = getFieldOverride("spirits", id, "name")!;
  assert.equal(override.action, "resolve_keep");
  assert.equal(override.source, "user");
  const audit = listReviewAudit("spirits", id);
  assert.equal(audit[0]?.action, "resolve_keep");
  assert.equal(JSON.stringify(audit).includes("pinHash"), false);
  cleanup();
});

test("admin can choose the competing conflict value", () => {
  cleanup();
  const id = insertSpirit();
  seedConflict(id);
  const result = resolveFieldConflict({
    entityType: "spirits",
    entityId: id,
    field: "name",
    choice: "accept"
  });
  assert.equal(result.value, "COLA Name");
  assert.equal(result.confidence, CONFIDENCE.VERY_HIGH);
  const row = db.prepare("SELECT name FROM spirits WHERE id=?").get(id) as { name: string };
  assert.equal(row.name, "COLA Name");
  assert.equal(result.view?.identity.name.value, "COLA Name");
  assert.equal(result.view?.identity.name.sourceLabel, "User");
  assert.equal(listReviewAudit("spirits", id)[0]?.action, "resolve_accept");
  cleanup();
});

test("mark-verified preserves value and promotes to user/VERY_HIGH", () => {
  cleanup();
  const id = insertSpirit({ abv: 45 });
  const result = verifyEnrichmentField({
    entityType: "spirits",
    entityId: id,
    field: "abv"
  });
  assert.equal(result.value, 45);
  assert.equal(result.source, "user");
  assert.equal(result.confidence, CONFIDENCE.VERY_HIGH);
  const row = db.prepare("SELECT abv FROM spirits WHERE id=?").get(id) as { abv: number };
  assert.equal(row.abv, 45);
  assert.ok(result.view?.verifiedFields?.includes("abv"));
  assert.equal(listReviewAudit("spirits", id)[0]?.action, "verify_field");
  cleanup();
});

test("user-verified field cannot later be overwritten by weaker enrichment", () => {
  cleanup();
  const id = insertSpirit({ abv: 45 });
  verifyEnrichmentField({ entityType: "spirits", entityId: id, field: "abv" });
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const candidate = candidateWithOverrides("spirits", id, row);
  assert.equal(candidate.abv.source, "user");
  assert.equal(candidate.abv.confidence, CONFIDENCE.VERY_HIGH);
  const merged = mergeField(candidate.abv, field(46, "web"), "abv");
  assert.equal(merged.overwritten, false);
  assert.equal(merged.field.value, 45);
  assert.equal(merged.field.source, "user");
  cleanup();
});

test("metadata, tasting_notes, and image enrichment can be requeued; duplicates prevented", () => {
  cleanup();
  const id = insertSpirit();
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Keep me",
    officialSourceUrl: "https://producer.example/x",
    officialSourceType: "official",
    houseProfile: "House keep"
  });

  const meta = rerunEnrichmentJob({ entityType: "spirits", entityId: id, jobType: "metadata" });
  assert.equal(meta.created, true);
  assert.equal(meta.job.status, "pending");
  const metaDup = rerunEnrichmentJob({ entityType: "spirits", entityId: id, jobType: "metadata" });
  assert.equal(metaDup.created, false);
  assert.equal(metaDup.job.id, meta.job.id);

  const tasting = rerunEnrichmentJob({
    entityType: "spirits",
    entityId: id,
    jobType: "tasting_notes"
  });
  assert.equal(tasting.created, true);
  const image = rerunEnrichmentJob({ entityType: "spirits", entityId: id, jobType: "image" });
  assert.equal(image.created, true);

  // Existing good tasting content retained while rerun is pending.
  assert.equal(getProductContent("spirits", id)?.official_tasting_notes, "Keep me");
  assert.equal(getProductContent("spirits", id)?.house_tasting_profile, "House keep");

  const audits = listReviewAudit("spirits", id);
  assert.ok(audits.some((a) => a.action === "rerun_enrichment" && a.job_type === "metadata"));
  assert.ok(audits.some((a) => a.job_type === "tasting_notes"));
  assert.ok(audits.some((a) => a.job_type === "image"));
  cleanup();
});

test("failed job retry works via admin rerun", () => {
  cleanup();
  const id = insertSpirit();
  const { job } = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC });
  claimNextPendingJob();
  // Exhaust attempts
  let current = job;
  for (let i = 0; i < 5; i += 1) {
    const next = markJobFailedOrRetry(current.id, "synthetic failure");
    if (!next) break;
    current = next;
    if (next.status === "failed") break;
    if (next.status === "pending") {
      db.prepare(`UPDATE enrichment_jobs SET available_at = datetime('now', '-1 second') WHERE id=?`).run(next.id);
      claimNextPendingJob();
    }
  }
  const failed = db
    .prepare(`SELECT status, last_error FROM enrichment_jobs WHERE entity_type='spirits' AND entity_id=? AND job_type='metadata' ORDER BY id DESC LIMIT 1`)
    .get(id) as { status: string; last_error: string };
  assert.equal(failed.status, "failed");

  const retry = rerunEnrichmentJob({ entityType: "spirits", entityId: id, jobType: "metadata" });
  assert.equal(retry.created, true);
  assert.equal(retry.job.status, "pending");
  assert.equal(listReviewAudit("spirits", id)[0]?.action, "retry_failed_job");
  cleanup();
});

test("completed-with-no-result tasting job can be requeued without wiping content table gaps", () => {
  cleanup();
  const id = insertSpirit();
  const { job } = enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC });
  // Use tasting job path
  clearEnrichmentJobsForTests();
  const tasting = rerunEnrichmentJob({
    entityType: "spirits",
    entityId: id,
    jobType: "tasting_notes"
  });
  markJobCompleted(tasting.job.id);
  assert.equal(getProductContent("spirits", id), null);
  const again = rerunEnrichmentJob({
    entityType: "spirits",
    entityId: id,
    jobType: "tasting_notes"
  });
  assert.equal(again.created, true);
  assert.equal(again.job.status, "pending");
  void job;
  cleanup();
});
