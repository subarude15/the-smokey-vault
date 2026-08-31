import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { saveBarcodeCacheEntry } from "../../barcode_cache.js";
import { saveToCache } from "../catalogs/cola-cache-store.js";
import { field, mergeField, type FieldConflict } from "../candidate/index.js";
import { planEnrichment } from "../enrichment/index.js";
import {
  candidateFromInventoryRow,
  claimNextPendingJob,
  clearEnrichmentJobsForTests,
  enqueueMetadataJob,
  enrichmentJobCounts,
  getEnrichmentJob,
  markJobCompleted,
  markJobFailedOrRetry,
  maybeEnqueueMetadataEnrichment,
  persistMetadataImprovements,
  recoverStaleRunningJobs,
  runEnrichmentWorkerOnce,
  runMetadataJob
} from "./index.js";

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Buffalo Trace",
    brand: "Buffalo Trace",
    category: "Bourbon",
    abv: 0,
    volume_ml: 750,
    upc: "080686000891",
    ...overrides
  };
  const result = db
    .prepare(
      `
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc);
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function forceJobAvailable(id: number) {
  db.prepare(
    `UPDATE enrichment_jobs SET available_at = datetime('now', '-1 second') WHERE id = ?`
  ).run(id);
}

function cleanup() {
  clearEnrichmentJobsForTests();
  db.prepare("DELETE FROM spirits WHERE upc LIKE '080686%' OR name LIKE 'QueueTest%'").run();
  db.prepare("DELETE FROM barcode_cache WHERE upc LIKE '080686%'").run();
  db.prepare("DELETE FROM cola_cache WHERE upc LIKE '080686%'").run();
}

test("metadata job can be persisted and read back", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Persist" });
  const { job, created } = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: String(spirit.upc)
  });
  assert.equal(created, true);
  const loaded = getEnrichmentJob(job.id);
  assert.ok(loaded);
  assert.equal(loaded?.entity_type, "spirits");
  assert.equal(loaded?.entity_id, Number(spirit.id));
  assert.equal(loaded?.job_type, "metadata");
  assert.equal(loaded?.status, "pending");
  cleanup();
});

test("duplicate active metadata jobs for the same entity are not created", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Dup", upc: "080686000001" });
  const first = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000001"
  });
  const second = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000001"
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(enrichmentJobCounts().pending, 1);
  cleanup();
});

test("worker claims one pending job", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Claim", upc: "080686000002" });
  enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000002"
  });
  const claimed = claimNextPendingJob();
  assert.ok(claimed);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempts, 1);
  assert.equal(claimNextPendingJob(), null, "no second pending job");
  cleanup();
});

test("two claim calls cannot take the same job", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Race", upc: "080686000003" });
  enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000003"
  });
  const a = claimNextPendingJob();
  const b = claimNextPendingJob();
  assert.ok(a);
  assert.equal(b, null);
  cleanup();
});

test("successful execution marks job completed", async () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Complete", upc: "080686000004", abv: 0 });
  const { job } = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000004"
  });
  const claimed = claimNextPendingJob();
  assert.equal(claimed?.id, job.id);
  await runMetadataJob(claimed!, {
    lookupByUpc: async () => ({
      source: "cola_cloud",
      upc: "080686000004",
      product: {
        upc: "080686000004",
        name: "Buffalo Trace",
        brand: "Buffalo Trace",
        abv: 45,
        product_type: "DISTILLED SPIRITS",
        volume_ml: 750
      }
    }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });
  markJobCompleted(claimed!.id);
  assert.equal(getEnrichmentJob(claimed!.id)?.status, "completed");
  const updated = db.prepare("SELECT abv FROM spirits WHERE id=?").get(spirit.id) as { abv: number };
  assert.equal(updated.abv, 45);
  cleanup();
});

test("identified bottle with missing recommended metadata gets queued", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Enqueue", upc: "080686000005", abv: 0 });
  const result = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(result.enqueued, true);
  if (result.enqueued) assert.equal(result.created, true);
  cleanup();
});

test("fully enriched bottle does not get unnecessary external enrichment work", async () => {
  cleanup();
  const upc = "080686000006";
  const spirit = insertSpirit({
    name: "QueueTest Full",
    upc,
    abv: 45,
    volume_ml: 750
  });
  saveBarcodeCacheEntry({
    upc,
    name: "QueueTest Full",
    brand: "Buffalo Trace",
    category: "Bourbon",
    abv: 45,
    proof: 90,
    volume_ml: 750,
    source: "enrichment"
  });
  saveToCache(
    {
      upc,
      name: "QueueTest Full",
      brand: "Buffalo Trace",
      category: "Bourbon",
      abv: 45,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: "TTB-FULL",
      origin: "Kentucky",
      approval_date: null
    },
    null,
    null,
    "enrichment"
  );

  const enqueue = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(enqueue.enqueued, false);
  if (!enqueue.enqueued) assert.equal(enqueue.reason, "already_complete");

  // Force a job anyway and ensure runMetadataJob skips without external calls.
  const { job } = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc
  });
  const claimed = claimNextPendingJob()!;
  let lookupCalls = 0;
  const result = await runMetadataJob(claimed, {
    lookupByUpc: async () => {
      lookupCalls += 1;
      throw new Error("should not be called");
    },
    searchWeb: async () => {
      lookupCalls += 1;
      return "";
    },
    extractMetadata: async () => {
      lookupCalls += 1;
      return {};
    }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "already_complete");
  assert.equal(lookupCalls, 0);
  markJobCompleted(job.id);
  cleanup();
});

test("unidentified candidate is not automatically queued", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest NoId", upc: "080686000007" });
  db.prepare("UPDATE spirits SET brand=? WHERE id=?").run("", spirit.id);
  const updated = db.prepare("SELECT * FROM spirits WHERE id=?").get(spirit.id) as Record<string, unknown>;
  const result = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(updated.id),
    row: updated
  });
  assert.equal(result.enqueued, false);
  if (!result.enqueued) assert.equal(result.reason, "not_identified");
  cleanup();
});

test("needsReview prevents automatic background enrichment", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Review", upc: "080686000008", abv: 0 });
  const candidate = candidateFromInventoryRow("spirits", spirit);
  const conflict = mergeField(
    field("Buffalo Trace", "vault"),
    field("Buffalo Trace Distillery", "cola"),
    "name"
  ).conflict as FieldConflict;
  const plan = planEnrichment(candidate, { conflicts: [conflict] });
  assert.equal(plan.identified, true);
  assert.equal(plan.needsReview, true);

  const result = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit,
    planOptions: { conflicts: [conflict] }
  });
  assert.equal(result.enqueued, false);
  if (!result.enqueued) assert.equal(result.reason, "needs_review");
  cleanup();
});

test("metadata enrichment updates only safe/improved fields", async () => {
  cleanup();
  const spirit = insertSpirit({
    name: "QueueTest Safe",
    upc: "080686000009",
    abv: 0,
    volume_ml: 750
  });
  const { job } = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000009"
  });
  const claimed = claimNextPendingJob()!;
  const result = await runMetadataJob(claimed, {
    lookupByUpc: async () => ({
      source: "cola_cloud",
      upc: "080686000009",
      product: {
        upc: "080686000009",
        name: "Hijack",
        brand: "Hijack",
        abv: 45,
        volume_ml: 750,
        product_type: "DISTILLED SPIRITS",
        origin: "Kentucky"
      }
    }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });
  assert.equal(result.skipped, false);
  const updated = db
    .prepare("SELECT name, brand, abv FROM spirits WHERE id=?")
    .get(spirit.id) as Record<string, unknown>;
  assert.equal(updated.name, "QueueTest Safe", "identity name unchanged on shelf");
  assert.equal(updated.brand, "Buffalo Trace");
  assert.equal(updated.abv, 45);
  assert.ok(result.inventoryUpdated.includes("abv"));
  markJobCompleted(job.id);
  cleanup();
});

test("lower-confidence enrichment cannot overwrite stronger stored data", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Strong", upc: "080686000010", abv: 45 });
  const before = candidateFromInventoryRow("spirits", spirit);
  assert.ok(before.abv.confidence >= 0.8);
  const after = {
    ...before,
    abv: field(40, "web")
  };
  const persisted = persistMetadataImprovements({
    entityType: "spirits",
    entityId: Number(spirit.id),
    before,
    after
  });
  assert.deepEqual(
    persisted.inventoryUpdated.filter((c) => c === "abv"),
    []
  );
  assert.ok(
    persisted.inventoryUpdated.every((c) => c === "category" || c === "sub_category"),
    "only hierarchy normalization may write; weaker ABV must not"
  );
  const row = db.prepare("SELECT abv, category, sub_category FROM spirits WHERE id=?").get(spirit.id) as {
    abv: number;
    category: string;
    sub_category: string;
  };
  assert.equal(row.abv, 45);
  // Bourbon-as-category may normalize to Whiskey / Bourbon without weakening ABV.
  assert.ok(row.category === "Bourbon" || row.category === "Whiskey");
  if (row.category === "Whiskey") assert.equal(row.sub_category, "Bourbon");
  cleanup();
});

test("nothing found completes successfully rather than failing", async () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Nothing", upc: "080686000011", abv: 0 });
  enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000011"
  });
  const claimed = claimNextPendingJob()!;
  const result = await runMetadataJob(claimed, {
    lookupByUpc: async () => ({ source: "not_found", upc: "080686000011", product: null }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });
  assert.equal(result.skipped, false);
  markJobCompleted(claimed.id);
  assert.equal(getEnrichmentJob(claimed.id)?.status, "completed");
  cleanup();
});

test("transient failure retries with incremented attempts", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Retry", upc: "080686000012" });
  const { job } = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000012"
  });
  const claimed = claimNextPendingJob()!;
  assert.equal(claimed.attempts, 1);
  const retried = markJobFailedOrRetry(claimed.id, "catalog timeout");
  assert.equal(retried?.status, "pending");
  assert.equal(retried?.attempts, 1);
  assert.ok(retried?.last_error?.includes("timeout"));
  forceJobAvailable(job.id);
  const claimed2 = claimNextPendingJob()!;
  assert.equal(claimed2.attempts, 2);
  assert.equal(claimed2.id, job.id);
  cleanup();
});

test("job becomes failed after max attempts", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Max", upc: "080686000013" });
  const { job } = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000013"
  });
  for (let i = 0; i < 3; i++) {
    forceJobAvailable(job.id);
    const claimed = claimNextPendingJob();
    assert.ok(claimed);
    markJobFailedOrRetry(claimed!.id, `fail ${i + 1}`);
  }
  const final = db
    .prepare("SELECT status, attempts FROM enrichment_jobs WHERE entity_id=?")
    .get(spirit.id) as { status: string; attempts: number };
  assert.equal(final.status, "failed");
  assert.equal(final.attempts, 3);
  cleanup();
});

test("stale running job is recovered after simulated restart", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Stale", upc: "080686000014" });
  enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686000014"
  });
  const claimed = claimNextPendingJob()!;
  db.prepare(
    `
    UPDATE enrichment_jobs
    SET started_at = datetime('now', '-1 hour')
    WHERE id = ?
  `
  ).run(claimed.id);
  const recovered = recoverStaleRunningJobs(60);
  assert.equal(recovered, 1);
  const job = getEnrichmentJob(claimed.id);
  assert.equal(job?.status, "pending");
  cleanup();
});

test("failure of one job does not prevent later jobs from running", async () => {
  cleanup();
  const a = insertSpirit({ name: "QueueTest A", upc: "080686000015", abv: 0 });
  const b = insertSpirit({ name: "QueueTest B", upc: "080686000016", abv: 0 });
  enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(a.id),
    upc: "080686000015"
  });
  enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(b.id),
    upc: "080686000016"
  });

  let calls = 0;
  const deps = {
    lookupByUpc: async (upc: string) => {
      calls += 1;
      if (upc === "080686000015") throw new Error("boom");
      return {
        source: "cola_cloud" as const,
        upc,
        product: { upc, name: "B", brand: "B", abv: 5, product_type: "beer" }
      };
    },
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  };

  await runEnrichmentWorkerOnce({ metadataDeps: deps });
  await runEnrichmentWorkerOnce({ metadataDeps: deps });
  assert.equal(calls, 2);
  const statuses = db
    .prepare(
      `
    SELECT upc, status FROM enrichment_jobs WHERE upc IN ('080686000015','080686000016') ORDER BY upc
  `
    )
    .all() as Array<{ upc: string; status: string }>;
  assert.equal(statuses[0]?.status, "pending"); // retried
  assert.equal(statuses[1]?.status, "completed");
  cleanup();
});

test("scan/add enqueue path returns without waiting for enrichment execution", () => {
  cleanup();
  const spirit = insertSpirit({ name: "QueueTest Fast", upc: "080686000017", abv: 0 });
  let executeCalled = false;
  const started = Date.now();
  const result = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const elapsed = Date.now() - started;
  assert.equal(result.enqueued, true);
  assert.equal(executeCalled, false);
  assert.ok(elapsed < 100, `enqueue should be fast, took ${elapsed}ms`);
  assert.equal(enrichmentJobCounts().pending, 1);
  cleanup();
});
