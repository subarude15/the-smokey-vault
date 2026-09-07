/**
 * Per-item Keeper enrichment queue / retry controls.
 * DirtWolf-style packaged beer + no_result / partial / failed / active / complete rerun.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { db } from "../../db.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  itemEnrichmentHasMissingWork,
  listJobsForEntity,
  markJobCompleted,
  normalizeItemEnrichmentJobTypes,
  normalizeItemEnrichmentQueueMode,
  primaryItemEnrichmentActionLabel,
  queueItemEnrichment,
  showsItemEnrichmentRerunAction,
  upsertProductContent,
  upsertProductImage
} from "./index.js";

const UPC = "080686999110";
const NAME = "DirtWolf ItemQueue";

function insertDirtWolf(overrides: Record<string, unknown> = {}) {
  const row = {
    brewery: "Victory Brewing Company",
    name: NAME,
    style: "Double IPA",
    abv: 8.7,
    upc: UPC,
    image_url: "",
    ...overrides
  };
  const result = db
    .prepare(
      `INSERT INTO packaged_beer (brewery, name, style, abv, upc, image_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(row.brewery, row.name, row.style, row.abv, row.upc, row.image_url);
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM packaged_beer WHERE id=?").get(id) as Record<string, unknown>;
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  db.prepare("DELETE FROM packaged_beer WHERE upc=? OR name LIKE ?").run(UPC, `${NAME}%`);
}

function seedCompleteTastingAndImage(entityId: number) {
  upsertProductContent({
    entityType: "packaged_beer",
    entityId,
    officialNotes: "Citrus peel, pine resin, firm bitterness.",
    officialSourceUrl: "https://www.victorybeer.com/beers/dirtwolf/",
    officialSourceType: "official",
    houseProfile: "Bold double IPA with grapefruit and resin."
  });
  const tasting = enqueueTastingNotesJob({
    entityType: "packaged_beer",
    entityId,
    upc: UPC
  });
  markJobCompleted(tasting.job.id);

  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "https://cdn.example/dirtwolf.jpg",
    sourceType: "official",
    sourceUrl: "https://www.victorybeer.com/beers/dirtwolf/",
    score: 92,
    verified: true
  });
  const image = enqueueImageJob({
    entityType: "packaged_beer",
    entityId,
    upc: UPC
  });
  markJobCompleted(image.job.id);
}

function statusMap(entityId: number) {
  const view = buildBottleEnrichmentView({
    entityType: "packaged_beer",
    entityId,
    includeDiagnostics: true
  });
  assert.ok(view);
  return Object.fromEntries(view!.enrichment.jobs.map((j) => [j.type, j.statusLabel])) as Record<
    string,
    string
  >;
}

function forceFailJob(jobId: number) {
  db.prepare(
    `UPDATE enrichment_jobs
     SET status = 'failed',
         attempts = max_attempts,
         last_error = ?,
         completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run("forced failure for item-queue test", jobId);
}

test("normalize helpers reject invalid jobTypes and mode", () => {
  assert.equal(normalizeItemEnrichmentJobTypes(undefined), undefined);
  assert.equal(normalizeItemEnrichmentJobTypes(["metadata", "image"])?.join(","), "metadata,image");
  assert.equal(normalizeItemEnrichmentJobTypes(["metadata", "nope"]), null);
  assert.equal(normalizeItemEnrichmentJobTypes([]), null);
  assert.equal(normalizeItemEnrichmentQueueMode(undefined), undefined);
  assert.equal(normalizeItemEnrichmentQueueMode("missing"), "missing");
  assert.equal(normalizeItemEnrichmentQueueMode("retry"), "retry");
  assert.equal(normalizeItemEnrichmentQueueMode("force"), null);
});

test("primary action labels and missing-work helpers", () => {
  assert.equal(primaryItemEnrichmentActionLabel("not_started"), "Run again");
  assert.equal(primaryItemEnrichmentActionLabel("no_result"), "Run again");
  assert.equal(primaryItemEnrichmentActionLabel("partial"), "Run again");
  assert.equal(primaryItemEnrichmentActionLabel("failed"), "Retry");
  assert.equal(primaryItemEnrichmentActionLabel("complete"), "Run again");
  assert.equal(primaryItemEnrichmentActionLabel("waiting"), null);
  assert.equal(primaryItemEnrichmentActionLabel("in_progress"), null);
  assert.equal(showsItemEnrichmentRerunAction("complete"), true);
  assert.equal(showsItemEnrichmentRerunAction("failed"), false);
  assert.equal(
    itemEnrichmentHasMissingWork([
      { type: "metadata", statusLabel: "not_started" },
      { type: "tasting_notes", statusLabel: "complete" }
    ]),
    true
  );
  assert.equal(
    itemEnrichmentHasMissingWork([{ type: "image", statusLabel: "complete" }]),
    false
  );
});

test("healthy beer has no missing metadata job; tasting and image stay complete", () => {
  cleanup();
  try {
    const beer = insertDirtWolf();
    const entityId = Number(beer.id);
    seedCompleteTastingAndImage(entityId);

    assert.deepEqual(statusMap(entityId), {
      metadata: "complete",
      tasting_notes: "complete",
      image: "complete"
    });

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      mode: "missing"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, []);
    assert.deepEqual(result.skipped, [
      { type: "metadata", reason: "already_complete" },
      { type: "tasting_notes", reason: "already_complete" },
      { type: "image", reason: "already_complete" }
    ]);

    const jobs = listJobsForEntity("packaged_beer", entityId);
    assert.equal(jobs.filter((j) => j.job_type === "metadata" && j.status === "pending").length, 0);
    assert.equal(jobs.filter((j) => j.job_type === "tasting_notes" && j.status === "pending").length, 0);
    assert.equal(jobs.filter((j) => j.job_type === "image" && j.status === "pending").length, 0);
  } finally {
    cleanup();
  }
});

test("DirtWolf explicit image retry re-queues complete image only", () => {
  cleanup();
  try {
    const beer = insertDirtWolf({ name: `${NAME} Rerun` });
    const entityId = Number(beer.id);
    seedCompleteTastingAndImage(entityId);

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      jobTypes: ["image"],
      mode: "retry"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, ["image"]);
    assert.deepEqual(result.skipped, []);

    const jobs = listJobsForEntity("packaged_beer", entityId);
    // listJobsForEntity returns latest-per-type only; after retry the image row is pending.
    assert.ok(jobs.some((j) => j.job_type === "image" && j.status === "pending"));
    assert.equal(jobs.filter((j) => j.job_type === "metadata" && j.status === "pending").length, 0);
    assert.equal(jobs.filter((j) => j.job_type === "tasting_notes" && j.status === "pending").length, 0);
    const priorCompleted = db
      .prepare(
        `SELECT COUNT(*) AS n FROM enrichment_jobs
         WHERE entity_type='packaged_beer' AND entity_id=? AND job_type='image' AND status='completed'`
      )
      .get(entityId) as { n: number };
    assert.ok(priorCompleted.n >= 1, "prior completed image history should remain");
  } finally {
    cleanup();
  }
});

test("no_result metadata is queueable in missing mode", () => {
  cleanup();
  try {
    // Empty style/abv so a completed empty run is no_result rather than partial.
    const beer = insertDirtWolf({ name: `${NAME} NoResult`, abv: 0, style: "" });
    const entityId = Number(beer.id);
    const { job } = enqueueMetadataJob({
      entityType: "packaged_beer",
      entityId,
      upc: UPC
    });
    markJobCompleted(job.id, {
      requested: ["abv", "origin"],
      updated: [],
      unresolved: ["abv", "origin"]
    });

    assert.equal(statusMap(entityId).metadata, "no_result");

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      jobTypes: ["metadata"],
      mode: "missing"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, ["metadata"]);
  } finally {
    cleanup();
  }
});

test("historical spirit-only beer gaps are complete but explicit metadata rerun still queues", () => {
  cleanup();
  try {
    const beer = insertDirtWolf({ name: `${NAME} Partial`, abv: 8.7 });
    const entityId = Number(beer.id);
    seedCompleteTastingAndImage(entityId);
    const { job } = enqueueMetadataJob({
      entityType: "packaged_beer",
      entityId,
      upc: UPC
    });
    markJobCompleted(job.id, {
      requested: ["abv", "origin", "volume_ml"],
      updated: ["abv"],
      unresolved: ["origin", "volume_ml"]
    });

    assert.equal(statusMap(entityId).metadata, "complete");

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      jobTypes: ["metadata"],
      mode: "retry"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, ["metadata"]);
    assert.equal(
      listJobsForEntity("packaged_beer", entityId).filter(
        (j) => j.job_type === "tasting_notes" && j.status === "pending"
      ).length,
      0
    );
    assert.equal(
      listJobsForEntity("packaged_beer", entityId).filter(
        (j) => j.job_type === "image" && j.status === "pending"
      ).length,
      0
    );
  } finally {
    cleanup();
  }
});

test("failed image Retry queues that item only", () => {
  cleanup();
  try {
    const beer = insertDirtWolf({ name: `${NAME} FailedImage` });
    const entityId = Number(beer.id);
    const { job } = enqueueImageJob({
      entityType: "packaged_beer",
      entityId,
      upc: UPC
    });
    forceFailJob(job.id);
    assert.equal(statusMap(entityId).image, "failed");

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      jobTypes: ["image"],
      mode: "retry"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, ["image"]);
    assert.equal(
      listJobsForEntity("packaged_beer", entityId).filter(
        (j) => j.job_type === "metadata" && j.status === "pending"
      ).length,
      0
    );
  } finally {
    cleanup();
  }
});

test("active waiting metadata is not duplicated", () => {
  cleanup();
  try {
    const beer = insertDirtWolf({ name: `${NAME} Active` });
    const entityId = Number(beer.id);
    const first = enqueueMetadataJob({
      entityType: "packaged_beer",
      entityId,
      upc: UPC
    });
    assert.equal(first.created, true);
    assert.equal(statusMap(entityId).metadata, "waiting");

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      jobTypes: ["metadata"],
      mode: "retry"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, []);
    assert.deepEqual(result.skipped, [{ type: "metadata", reason: "already_queued" }]);
    assert.equal(
      listJobsForEntity("packaged_beer", entityId).filter((j) => j.job_type === "metadata").length,
      1
    );
  } finally {
    cleanup();
  }
});

test("user/shelf image remains protected on explicit image retry", () => {
  cleanup();
  try {
    // isLocalImagePath only accepts /api/media/images/* shelf paths.
    const beer = insertDirtWolf({
      name: `${NAME} UserImage`,
      image_url: "/api/media/images/shelf-dirtwolf.jpg"
    });
    const entityId = Number(beer.id);
    upsertProductImage({
      entityType: "packaged_beer",
      entityId,
      url: "/api/media/images/shelf-dirtwolf.jpg",
      sourceType: "user",
      verified: true,
      score: 100
    });

    const result = queueItemEnrichment({
      entityType: "packaged_beer",
      entityId,
      jobTypes: ["image"],
      mode: "retry"
    });
    assert.ok(!("error" in result));
    assert.deepEqual(result.queued, []);
    assert.deepEqual(result.skipped, [{ type: "image", reason: "user_image_protected" }]);
  } finally {
    cleanup();
  }
});

test("EnrichmentPanel exposes Keeper queue controls and guest App gate", () => {
  const root = process.cwd();
  const panel = readFileSync(join(root, "client/src/EnrichmentPanel.tsx"), "utf8");
  const app = readFileSync(join(root, "client/src/App.tsx"), "utf8");
  const publicContent = readFileSync(join(root, "client/src/BottlePublicContent.tsx"), "utf8");

  assert.match(panel, /keepers only/);
  assert.match(panel, /Queue missing enrichment/);
  assert.match(panel, /Nothing missing/);
  assert.match(panel, /enrichment\/queue/);
  assert.match(panel, /enrichment\/rerun/);
  assert.match(panel, /Run again/);
  assert.match(panel, /Retry/);
  assert.match(panel, /Keep current/);
  assert.match(panel, /Use competing/);
  assert.match(panel, /Mark .* verified/);
  assert.match(app, /admin && ENRICHMENT_MODULES\.has\(module\.id\) \? <EnrichmentPanel/);
  assert.doesNotMatch(publicContent, /Queue missing enrichment/);
  assert.doesNotMatch(publicContent, /enrichment\/queue/);
  assert.doesNotMatch(publicContent, /Run again/);
});
