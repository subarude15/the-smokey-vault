import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { field, mergeField, type FieldConflict } from "../candidate/index.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_SCORE,
  classifyImageSource,
  evaluateCandidate,
  hardRejectCandidate,
  scoreImageCandidateBase,
  type ImageCandidate,
  type VisionVerification
} from "../enrichment/index.js";
import {
  claimNextPendingJob,
  clearEnrichmentJobsForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  getEnrichmentJob,
  getProductImage,
  markJobCompleted,
  maybeEnqueueImageEnrichment,
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  runEnrichmentWorkerOnce,
  runImageJob
} from "./index.js";

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Buffalo Trace",
    brand: "Buffalo Trace",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc: "080686200001",
    image_url: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc, row.image_url);
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  db.prepare("DELETE FROM spirits WHERE upc LIKE '0806862%' OR name LIKE 'ImageTest%'").run();
}

function officialCandidate(overrides: Partial<ImageCandidate> = {}): ImageCandidate {
  return {
    url: "https://cdn.buffalotrace.com/products/buffalo-trace.jpg",
    sourceUrl: "https://www.buffalotrace.com/products/buffalo-trace",
    sourceType: "official",
    width: 1400,
    height: 1400,
    mimeType: "image/jpeg",
    ...overrides
  };
}

const cleanVision: VisionVerification = {
  correct_product: true,
  bottle_prominent: true,
  contains_people: false,
  meme_or_graphic: false,
  clean_product_photo: true,
  multiple_products: false
};

test("identified bottle can enqueue image job", () => {
  cleanup();
  const spirit = insertSpirit({ name: "ImageTest Enqueue", upc: "080686200101" });
  const result = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(result.enqueued, true);
  if (result.enqueued) {
    assert.equal(result.job.job_type, "image");
    assert.equal(result.created, true);
  }
  cleanup();
});

test("unidentified bottle does not automatically enqueue image job", () => {
  cleanup();
  const spirit = insertSpirit({ name: "ImageTest NoId", upc: "080686200102" });
  db.prepare("UPDATE spirits SET brand=? WHERE id=?").run("", spirit.id);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(spirit.id) as Record<string, unknown>;
  const result = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(row.id),
    row
  });
  assert.equal(result.enqueued, false);
  if (!result.enqueued) assert.equal(result.reason, "not_identified");
  cleanup();
});

test("needsReview prevents automatic image enrichment", () => {
  cleanup();
  const spirit = insertSpirit({ name: "ImageTest Review", upc: "080686200103" });
  const conflict = mergeField(
    field("Buffalo Trace", "vault"),
    field("Buffalo Trace Distillery", "cola"),
    "name"
  ).conflict as FieldConflict;
  const result = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit,
    planOptions: { conflicts: [conflict] }
  });
  assert.equal(result.enqueued, false);
  if (!result.enqueued) assert.equal(result.reason, "needs_review");
  cleanup();
});

test("duplicate active image jobs are deduped", () => {
  cleanup();
  const spirit = insertSpirit({ name: "ImageTest Dup", upc: "080686200104" });
  const first = enqueueImageJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686200104"
  });
  const second = enqueueImageJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686200104"
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  cleanup();
});

test("existing user image prevents lower-priority replacement", async () => {
  cleanup();
  const spirit = insertSpirit({
    name: "ImageTest User",
    upc: "080686200105",
    image_url: "/api/media/images/userphoto.jpg"
  });
  const enqueue = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(enqueue.enqueued, false);

  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc: "080686200105" });
  const result = await runEnrichmentWorkerOnce({
    imageDeps: {
      searchImageHits: async () => {
        throw new Error("should not search when user image present");
      }
    }
  });
  assert.equal(result, true);
  const row = db.prepare("SELECT image_url FROM spirits WHERE id=?").get(spirit.id) as { image_url: string };
  assert.equal(row.image_url, "/api/media/images/userphoto.jpg");
  const stored = getProductImage("spirits", Number(spirit.id));
  assert.equal(stored?.source_type, "user");
  assert.equal(stored?.url, "/api/media/images/userphoto.jpg");
  cleanup();
});

test("official high-resolution product image scores highly", () => {
  const candidate = officialCandidate();
  assert.equal(hardRejectCandidate(candidate).rejected, false);
  const base = scoreImageCandidateBase(candidate);
  assert.ok(base >= IMAGE_SCORE.officialSource + IMAGE_SCORE.largeImage);
  const scored = evaluateCandidate(candidate, cleanVision);
  assert.equal(scored.rejected, false);
  assert.ok(scored.score >= IMAGE_ACCEPTANCE_THRESHOLD);
  assert.ok(scored.score >= IMAGE_SCORE.officialSource + IMAGE_SCORE.exactIdentityMatch + IMAGE_SCORE.cleanProductPhoto);
});

test("low-resolution thumbnail is rejected/penalized", () => {
  const tiny = officialCandidate({ width: 120, height: 120, url: "https://cdn.buffalotrace.com/thumb_s.jpg" });
  const hard = hardRejectCandidate(tiny);
  assert.equal(hard.rejected, true);
  assert.equal(hard.reason, "low_resolution");
});

test("retailer image is not automatically accepted", () => {
  assert.equal(
    classifyImageSource("https://www.totalwine.com/media/buffalo.jpg", {
      brand: "Buffalo Trace",
      pageUrl: "https://www.totalwine.com/spirits/buffalo-trace"
    }),
    "unknown"
  );
  const retailer: ImageCandidate = {
    url: "https://www.totalwine.com/media/buffalo.jpg",
    sourceUrl: "https://www.totalwine.com/spirits/buffalo-trace",
    sourceType: "unknown",
    width: 1600,
    height: 1600,
    mimeType: "image/jpeg"
  };
  assert.equal(hardRejectCandidate(retailer).rejected, true);
  assert.equal(hardRejectCandidate(retailer).reason, "unapproved_source");
});

test("person-heavy image is rejected/penalized", () => {
  const scored = evaluateCandidate(officialCandidate(), {
    ...cleanVision,
    contains_people: true,
    clean_product_photo: true,
    bottle_prominent: true,
    correct_product: true
  });
  // Base official+large+identity+clean = 100, person -40 = 60 < 75 → contains_people reject
  assert.equal(scored.rejected, true);
  assert.equal(scored.rejectionReason, "contains_people");
  assert.ok(scored.score < IMAGE_ACCEPTANCE_THRESHOLD);
});

test("meme/text-heavy graphic is rejected", () => {
  const scored = evaluateCandidate(officialCandidate(), {
    ...cleanVision,
    meme_or_graphic: true,
    clean_product_photo: false
  });
  assert.equal(scored.rejected, true);
  assert.equal(scored.rejectionReason, "meme_or_graphic");
});

test("correct clean bottle image passes verification", async () => {
  cleanup();
  const upc = "080686200106";
  const spirit = insertSpirit({ name: "ImageTest Pass", upc });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runImageJob(claimed, {
    searchImageHits: async () => [
      {
        url: "https://cdn.buffalotrace.com/products/bt.jpg",
        sourceUrl: "https://www.buffalotrace.com/bt",
        width: 1500,
        height: 1500,
        mimeType: "image/jpeg"
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 1500,
      height: 1500,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => cleanVision
  });
  assert.equal(result.skipped, false);
  assert.equal(result.imageSaved, true);
  const stored = getProductImage("spirits", Number(spirit.id));
  assert.ok(stored?.url?.includes("buffalotrace.com"));
  assert.equal(stored?.verified, true);
  assert.ok((stored?.score ?? 0) >= IMAGE_ACCEPTANCE_THRESHOLD);
  markJobCompleted(claimed.id);
  cleanup();
});

test("wrong product image fails verification", async () => {
  cleanup();
  const upc = "080686200107";
  const spirit = insertSpirit({ name: "ImageTest Wrong", upc });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runImageJob(claimed, {
    searchImageHits: async () => [
      {
        url: "https://cdn.buffalotrace.com/other.jpg",
        sourceUrl: "https://www.buffalotrace.com/other",
        width: 1500,
        height: 1500
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 1500,
      height: 1500,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => ({
      correct_product: false,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    })
  });
  assert.equal(result.imageSaved, false);
  assert.equal(getProductImage("spirits", Number(spirit.id))?.url ?? null, null);
  markJobCompleted(claimed.id);
  cleanup();
});

test("no acceptable image completes successfully with null/no image", async () => {
  cleanup();
  const upc = "080686200108";
  const spirit = insertSpirit({ name: "ImageTest None", upc });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runImageJob(claimed, {
    searchImageHits: async () => [],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({ width: null, height: null, mimeType: null, reachable: false }),
    verifyImage: async () => null
  });
  assert.equal(result.skipped, false);
  assert.equal(result.imageSaved, false);
  markJobCompleted(claimed.id);
  assert.equal(getEnrichmentJob(claimed.id)?.status, "completed");
  assert.equal(getProductImage("spirits", Number(spirit.id))?.url ?? null, null);
  assert.equal(getProductImage("spirits", Number(spirit.id))?.rejection_reason, "no_acceptable_image");
  cleanup();
});

test("image job failure does not affect bottle identity/inventory", async () => {
  cleanup();
  const upc = "080686200109";
  const spirit = insertSpirit({ name: "ImageTest Fail", brand: "KeepBrand", upc, abv: 45 });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  await runEnrichmentWorkerOnce({
    imageDeps: {
      searchImageHits: async () => {
        throw new Error("searxng down");
      },
      searchWebHits: async () => {
        throw new Error("web down");
      }
    }
  });
  const row = db.prepare("SELECT name, brand, abv, image_url FROM spirits WHERE id=?").get(spirit.id) as Record<string, unknown>;
  assert.equal(row.name, "ImageTest Fail");
  assert.equal(row.brand, "KeepBrand");
  assert.equal(row.abv, 45);
  assert.equal(row.image_url, "");
  const job = db.prepare("SELECT status FROM enrichment_jobs WHERE entity_id=? AND job_type='image'")
    .get(spirit.id) as { status: string };
  assert.equal(job.status, "pending");
  cleanup();
});

test("scan response does not wait for image execution", () => {
  cleanup();
  const spirit = insertSpirit({ name: "ImageTest Fast", upc: "080686200110" });
  const started = Date.now();
  const result = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const elapsed = Date.now() - started;
  assert.equal(result.enqueued, true);
  assert.ok(elapsed < 100, `enqueue took ${elapsed}ms`);
  assert.equal(getProductImage("spirits", Number(spirit.id)), null);
  cleanup();
});

test("worker continues processing later jobs after image job failure", async () => {
  cleanup();
  const a = insertSpirit({ name: "ImageTest A", upc: "080686200111" });
  const b = insertSpirit({ name: "ImageTest B", upc: "080686200112" });
  enqueueImageJob({ entityType: "spirits", entityId: Number(a.id), upc: "080686200111" });
  enqueueImageJob({ entityType: "spirits", entityId: Number(b.id), upc: "080686200112" });

  await runEnrichmentWorkerOnce({
    imageDeps: {
      searchImageHits: async () => {
        throw new Error("boom");
      },
      searchWebHits: async () => {
        throw new Error("boom");
      }
    }
  });
  await runEnrichmentWorkerOnce({
    imageDeps: {
      searchImageHits: async () => [
        {
          url: "https://cdn.buffalotrace.com/b.jpg",
          sourceUrl: "https://www.buffalotrace.com/b",
          width: 1400,
          height: 1400
        }
      ],
      searchWebHits: async () => [],
      probeImageMeta: async () => ({
        width: 1400,
        height: 1400,
        mimeType: "image/jpeg",
        reachable: true
      }),
      verifyImage: async () => cleanVision
    }
  });

  const statuses = db.prepare(`
    SELECT upc, status FROM enrichment_jobs
    WHERE upc IN ('080686200111','080686200112')
    ORDER BY upc
  `).all() as Array<{ upc: string; status: string }>;
  assert.equal(statuses[0]?.status, "pending");
  assert.equal(statuses[1]?.status, "completed");
  cleanup();
});

test("metadata/tasting-note jobs remain unchanged", () => {
  cleanup();
  const spirit = insertSpirit({ name: "ImageTest Meta", upc: "080686200113", abv: 0 });
  const meta = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const taste = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const image = maybeEnqueueImageEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(meta.enqueued, true);
  assert.equal(taste.enqueued, true);
  assert.equal(image.enqueued, true);
  if (meta.enqueued && taste.enqueued && image.enqueued) {
    assert.equal(meta.job.job_type, "metadata");
    assert.equal(taste.job.job_type, "tasting_notes");
    assert.equal(image.job.job_type, "image");
    assert.notEqual(meta.job.id, image.job.id);
  }
  assert.equal(
    enqueueMetadataJob({
      entityType: "spirits",
      entityId: Number(spirit.id),
      upc: "080686200113"
    }).created,
    false
  );
  assert.equal(
    enqueueTastingNotesJob({
      entityType: "spirits",
      entityId: Number(spirit.id),
      upc: "080686200113"
    }).created,
    false
  );
  cleanup();
});

test("provider_error with evaluated candidates still throws for queue retry", async () => {
  cleanup();
  const upc = "080686200114";
  const spirit = insertSpirit({ name: "ImageTest ProviderFail", brand: "Buffalo Trace", upc });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;

  await assert.rejects(
    () =>
      runImageJob(claimed, {
        searchImageHits: async () => [
          {
            url: "https://cdn.buffalotrace.com/products/bt.jpg",
            sourceUrl: "https://www.buffalotrace.com/bt",
            width: 1500,
            height: 1500,
            mimeType: "image/jpeg"
          }
        ],
        searchWebHits: async () => [],
        probeImageMeta: async () => ({
          width: 1500,
          height: 1500,
          mimeType: "image/jpeg",
          reachable: true
        }),
        verifyImage: async () => {
          throw new Error("vision_provider_error: Ollama returned 500");
        }
      }),
    /vision_provider_error|Ollama|provider/i
  );

  // Must NOT mark as deterministic empty — job should retry instead.
  assert.equal(getProductImage("spirits", Number(spirit.id)), null);
  cleanup();
});

test("deterministic image rejection completes without throwing", async () => {
  cleanup();
  const upc = "080686200115";
  const spirit = insertSpirit({ name: "ImageTest Deterministic", brand: "Buffalo Trace", upc });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runImageJob(claimed, {
    searchImageHits: async () => [
      {
        url: "https://cdn.buffalotrace.com/products/bt.jpg",
        sourceUrl: "https://www.buffalotrace.com/bt",
        width: 1500,
        height: 1500,
        mimeType: "image/jpeg"
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 1500,
      height: 1500,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => ({
      correct_product: false,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    })
  });
  assert.equal(result.skipped, false);
  assert.equal(result.imageSaved, false);
  assert.ok(result.execution?.evaluated.length);
  assert.notEqual(result.execution?.diagnostics.noResultReason, "provider_error");
  assert.equal(getProductImage("spirits", Number(spirit.id))?.rejection_reason, "no_acceptable_image");
  cleanup();
});

test("vision_parse_failed causes runImageJob retry (no empty mark)", async () => {
  cleanup();
  const upc = "080686200116";
  const spirit = insertSpirit({ name: "ImageTest VisionParseFail", brand: "Buffalo Trace", upc });
  enqueueImageJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;

  await assert.rejects(
    () =>
      runImageJob(claimed, {
        searchImageHits: async () => [
          {
            url: "https://cdn.buffalotrace.com/products/bt.jpg",
            sourceUrl: "https://www.buffalotrace.com/bt"
          }
        ],
        searchWebHits: async () => [],
        probeImageMeta: async () => ({
          width: 1500,
          height: 1500,
          mimeType: "image/jpeg",
          reachable: true
        }),
        verifyImage: async () => {
          throw new Error("vision_parse_failed");
        }
      }),
    /vision_parse_failed|provider/i
  );
  assert.equal(getProductImage("spirits", Number(spirit.id)), null);
  cleanup();
});
