/**
 * Admin enrichment backfill: preview/queue missing jobs without mutating canonical inventory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { saveToCache } from "./ingestion/catalogs/cola-cache-store.js";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import {
  clearAdminAuditForTests,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  enqueueImageJob,
  getLatestAdminAuditEvent,
  getProductContent,
  markJobCompleted,
  previewEnrichmentBackfill,
  queueEnrichmentBackfill,
  shouldScheduleImageEnrichment,
  upsertProductContent,
  upsertProductImage
} from "./ingestion/jobs/index.js";
import { db } from "./db.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");

const UPC = "080686500001";
const PREFIX = "0806865";

/** Seed cache-only metadata (proof/origin/ttb) so spirits can be truly metadata-complete. */
function seedCompleteMetadataCaches(upc: string, name: string, brand: string, category = "Whiskey") {
  saveToCache(
    {
      upc,
      name,
      brand,
      category,
      abv: 45,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: "TTB-COMPLETE-1",
      origin: "Kentucky",
      approval_date: null
    },
    null,
    null,
    "cola_cloud"
  );
  saveBarcodeCacheEntry({
    upc,
    name,
    brand,
    category,
    abv: 45,
    proof: 90,
    volume_ml: 750,
    source: "enrichment"
  });
}

/** Minimal valid JPEG (1x1). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64"
);

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Backfill Bottle",
    brand: "Backfill Brand",
    category: "Bourbon",
    abv: 0,
    volume_ml: 750,
    upc: UPC,
    notes: "keeper note",
    tasting_notes: "keeper tasting",
    image_url: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    row.brand,
    row.category,
    row.abv,
    row.volume_ml,
    row.upc,
    row.notes,
    row.tasting_notes,
    row.image_url
  );
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function jobCount(entityId: number, jobType: string) {
  return Number(
    (
      db.prepare(`
        SELECT COUNT(*) AS n FROM enrichment_jobs
        WHERE entity_type='spirits' AND entity_id=? AND job_type=?
      `).get(entityId, jobType) as { n: number }
    ).n
  );
}

function activeJobCount(entityId: number, jobType: string) {
  return Number(
    (
      db.prepare(`
        SELECT COUNT(*) AS n FROM enrichment_jobs
        WHERE entity_type='spirits' AND entity_id=? AND job_type=? AND status IN ('pending','running')
      `).get(entityId, jobType) as { n: number }
    ).n
  );
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  clearAdminAuditForTests();
  db.prepare("DELETE FROM reviews WHERE table_name='spirits'").run();
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%'`).run();
}

test("unauthorized user cannot preview or queue enrichment backfill", async () => {
  cleanup();
  try {
    const preview = await app.inject({ method: "GET", url: "/api/admin/enrichment/backfill" });
    assert.equal(preview.statusCode, 401);

    const queue = await app.inject({
      method: "POST",
      url: "/api/admin/enrichment/backfill",
      payload: {}
    });
    assert.equal(queue.statusCode, 401);
  } finally {
    cleanup();
  }
});

test("admin can preview without mutating queue or inventory", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0002`, abv: 0 });
  const id = Number(spirit.id);
  const beforeJobs = jobCount(id, "metadata");
  const beforeAbv = (db.prepare("SELECT abv FROM spirits WHERE id=?").get(id) as { abv: number }).abv;

  try {
    const token = createTestAdminToken();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/enrichment/backfill",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { scanned: number; metadata: number };
    assert.ok(body.scanned >= 1);
    assert.ok(body.metadata >= 1);
    assert.equal(jobCount(id, "metadata"), beforeJobs);
    assert.equal(
      (db.prepare("SELECT abv FROM spirits WHERE id=?").get(id) as { abv: number }).abv,
      beforeAbv
    );
  } finally {
    cleanup();
  }
});

test("identified eligible bottle queues missing metadata via backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0003`, abv: 0 });
  const id = Number(spirit.id);
  try {
    const preview = previewEnrichmentBackfill();
    assert.ok(preview.metadata >= 1);
    const result = queueEnrichmentBackfill({ types: ["metadata"] });
    assert.ok(result.queued.metadata >= 1);
    assert.equal(activeJobCount(id, "metadata"), 1);
  } finally {
    cleanup();
  }
});

test("eligible bottle queues tasting-notes job via backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0004`, abv: 45 });
  const id = Number(spirit.id);
  try {
    const result = queueEnrichmentBackfill({ types: ["tasting_notes"] });
    assert.ok(result.queued.tasting_notes >= 1);
    assert.equal(activeJobCount(id, "tasting_notes"), 1);
  } finally {
    cleanup();
  }
});

test("eligible bottle queues image job via backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0005`, abv: 45, image_url: "" });
  const id = Number(spirit.id);
  try {
    const result = queueEnrichmentBackfill({ types: ["image"] });
    assert.ok(result.queued.image >= 1);
    assert.equal(activeJobCount(id, "image"), 1);
  } finally {
    cleanup();
  }
});

test("fully enriched bottle queues nothing", () => {
  cleanup();
  const upc = `${PREFIX}000006`;
  const spirit = insertSpirit({ upc, abv: 45, volume_ml: 750, category: "Whiskey" });
  const id = Number(spirit.id);
  seedCompleteMetadataCaches(upc, String(spirit.name), String(spirit.brand), "Whiskey");
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Official notes.",
    officialSourceUrl: "https://producer.example/x",
    officialSourceType: "official",
    houseProfile: "House profile."
  });
  upsertProductImage({
    entityType: "spirits",
    entityId: id,
    url: "/api/media/images/fully-enriched-bottle.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/x",
    score: 92,
    verified: true
  });
  markJobCompleted(
    enqueueMetadataJob({ entityType: "spirits", entityId: id, upc }).job.id,
    {
      requested: ["category", "abv", "proof", "volume_ml", "origin", "ttb_id"],
      updated: ["category", "abv", "proof", "origin", "ttb_id"],
      unresolved: []
    }
  );
  markJobCompleted(
    enqueueTastingNotesJob({ entityType: "spirits", entityId: id, upc }).job.id
  );
  markJobCompleted(
    enqueueImageJob({ entityType: "spirits", entityId: id, upc }).job.id
  );

  try {
    const preview = previewEnrichmentBackfill();
    const before = preview.metadata + preview.tastingNotes + preview.images;
    const result = queueEnrichmentBackfill();
    assert.equal(result.queued.metadata, 0);
    assert.equal(result.queued.tasting_notes, 0);
    assert.equal(result.queued.image, 0);
    assert.ok(preview.alreadyComplete >= 1 || before === 0);
  } finally {
    cleanup();
  }
});

test("accepted remote image remains backfill-schedulable for localization repair", () => {
  cleanup();
  const upc = `${PREFIX}000006b`;
  const spirit = insertSpirit({ upc, abv: 45, volume_ml: 750, category: "Whiskey" });
  const id = Number(spirit.id);
  seedCompleteMetadataCaches(upc, String(spirit.name), String(spirit.brand), "Whiskey");
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Official notes.",
    officialSourceUrl: "https://producer.example/x",
    officialSourceType: "official",
    houseProfile: "House profile."
  });
  upsertProductImage({
    entityType: "spirits",
    entityId: id,
    url: "https://cdn.example/remote-accepted.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/x",
    score: 75,
    verified: true
  });
  markJobCompleted(
    enqueueMetadataJob({ entityType: "spirits", entityId: id, upc }).job.id,
    {
      requested: ["category", "abv", "proof", "volume_ml", "origin", "ttb_id"],
      updated: ["category", "abv", "proof", "origin", "ttb_id"],
      unresolved: []
    }
  );
  markJobCompleted(
    enqueueTastingNotesJob({ entityType: "spirits", entityId: id, upc }).job.id
  );
  markJobCompleted(
    enqueueImageJob({ entityType: "spirits", entityId: id, upc }).job.id
  );

  try {
    assert.equal(
      shouldScheduleImageEnrichment({ entityType: "spirits", entityId: id, row: spirit }),
      true
    );
    const preview = previewEnrichmentBackfill();
    assert.ok(preview.images >= 1);
    const result = queueEnrichmentBackfill({ types: ["image"] });
    assert.ok(result.queued.image >= 1);
  } finally {
    cleanup();
  }
});

test("needsReview bottle is skipped by backfill", () => {
  cleanup();
  const upc = `${PREFIX}0007`;
  insertSpirit({ name: "Vault Name", brand: "Vault Brand", upc });
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
  try {
    const preview = previewEnrichmentBackfill();
    assert.ok(preview.needsReview >= 1);
    const result = queueEnrichmentBackfill();
    assert.equal(result.queued.metadata, 0);
    assert.equal(result.queued.tasting_notes, 0);
    assert.equal(result.queued.image, 0);
    assert.ok(result.skipped.needs_review >= 1);
  } finally {
    cleanup();
  }
});

test("unidentified bottle is skipped by backfill", () => {
  cleanup();
  insertSpirit({ name: "", brand: "", upc: "", abv: 0 });
  try {
    const preview = previewEnrichmentBackfill();
    assert.ok(preview.unidentified >= 1);
    const result = queueEnrichmentBackfill();
    assert.ok(result.skipped.unidentified >= 1);
  } finally {
    cleanup();
  }
});

test("active metadata job is not duplicated by backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0008`, abv: 0 });
  const id = Number(spirit.id);
  enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0008` });
  try {
    queueEnrichmentBackfill({ types: ["metadata"] });
    assert.equal(activeJobCount(id, "metadata"), 1);
    assert.equal(jobCount(id, "metadata"), 1);
  } finally {
    cleanup();
  }
});

test("active tasting-notes job is not duplicated by backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0009`, abv: 45 });
  const id = Number(spirit.id);
  enqueueTastingNotesJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0009` });
  try {
    queueEnrichmentBackfill({ types: ["tasting_notes"] });
    assert.equal(activeJobCount(id, "tasting_notes"), 1);
    assert.equal(jobCount(id, "tasting_notes"), 1);
  } finally {
    cleanup();
  }
});

test("active image job is not duplicated by backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0010`, abv: 45 });
  const id = Number(spirit.id);
  enqueueImageJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0010` });
  try {
    queueEnrichmentBackfill({ types: ["image"] });
    assert.equal(activeJobCount(id, "image"), 1);
    assert.equal(jobCount(id, "image"), 1);
  } finally {
    cleanup();
  }
});

test("completed-null tasting result is not endlessly requeued by backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0011`, abv: 45 });
  const id = Number(spirit.id);
  const job = enqueueTastingNotesJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0011` }).job;
  markJobCompleted(job.id);
  try {
    const first = queueEnrichmentBackfill({ types: ["tasting_notes"] });
    assert.equal(first.queued.tasting_notes, 0);
    const second = queueEnrichmentBackfill({ types: ["tasting_notes"] });
    assert.equal(second.queued.tasting_notes, 0);
    assert.equal(jobCount(id, "tasting_notes"), 1);
  } finally {
    cleanup();
  }
});

test("completed-null image result is not endlessly requeued by backfill", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0012`, abv: 45 });
  const id = Number(spirit.id);
  const job = enqueueImageJob({ entityType: "spirits", entityId: id, upc: `${PREFIX}0012` }).job;
  markJobCompleted(job.id);
  try {
    const first = queueEnrichmentBackfill({ types: ["image"] });
    assert.equal(first.queued.image, 0);
    const second = queueEnrichmentBackfill({ types: ["image"] });
    assert.equal(second.queued.image, 0);
    assert.equal(jobCount(id, "image"), 1);
  } finally {
    cleanup();
  }
});

test("user-verified canonical inventory fields remain unchanged after backfill", () => {
  cleanup();
  const spirit = insertSpirit({
    upc: `${PREFIX}0013`,
    abv: 47.5,
    volume_ml: 700,
    notes: "Verified cellar note",
    tasting_notes: "Verified personal tasting"
  });
  const id = Number(spirit.id);
  const before = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  try {
    queueEnrichmentBackfill();
    const after = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
    assert.equal(after.abv, before.abv);
    assert.equal(after.volume_ml, before.volume_ml);
    assert.equal(after.notes, before.notes);
    assert.equal(after.tasting_notes, before.tasting_notes);
    assert.equal(after.name, before.name);
    assert.equal(after.brand, before.brand);
  } finally {
    cleanup();
  }
});

test("backfill returns immediately without waiting for job execution", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0014`, abv: 0 });
  const id = Number(spirit.id);
  const token = createTestAdminToken();
  try {
    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/enrichment/backfill",
      headers: { authorization: `Bearer ${token}` },
      payload: { types: ["metadata", "tasting_notes", "image"] }
    });
    const elapsed = Date.now() - started;
    assert.equal(res.statusCode, 200);
    assert.ok(elapsed < 500, `backfill took ${elapsed}ms`);
    assert.equal(getProductContent("spirits", id), null);
  } finally {
    cleanup();
  }
});

test("patron reviews remain unchanged after enrichment backfill", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0015`, abv: 45 });
  const id = Number(spirit.id);
  try {
    const review = await app.inject({
      method: "POST",
      url: `/api/inventory/spirits/${id}/reviews`,
      payload: { author: "Patron", body: "Smooth finish." }
    });
    assert.equal(review.statusCode, 201);

    const token = createTestAdminToken();
    await app.inject({
      method: "POST",
      url: "/api/admin/enrichment/backfill",
      headers: { authorization: `Bearer ${token}` },
      payload: {}
    });

    const listed = await app.inject({ method: "GET", url: `/api/inventory/spirits/${id}/reviews` });
    assert.equal(listed.statusCode, 200);
    const reviews = listed.json() as Array<{ author: string; body: string }>;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.author, "Patron");
  } finally {
    cleanup();
  }
});

test("patron gallery uploads remain unchanged after enrichment backfill", async () => {
  cleanup();
  insertSpirit({ upc: `${PREFIX}0016`, abv: 45 });
  const boundary = "----backfillGallery";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="night.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`
    ),
    TINY_JPEG,
    Buffer.from(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\nFriday pour\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="uploaded_by"\r\n\r\nAlex\r\n` +
        `--${boundary}--\r\n`
    )
  ]);
  try {
    const upload = await app.inject({
      method: "POST",
      url: "/api/gallery/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body
    });
    assert.equal(upload.statusCode, 201);
    const media = upload.json() as { id: number; uploaded_by: string; caption: string };

    const token = createTestAdminToken();
    await app.inject({
      method: "POST",
      url: "/api/admin/enrichment/backfill",
      headers: { authorization: `Bearer ${token}` },
      payload: {}
    });

    const row = db.prepare("SELECT uploaded_by, caption FROM gallery_media WHERE id=?").get(media.id) as {
      uploaded_by: string;
      caption: string;
    };
    assert.equal(row.uploaded_by, "Alex");
    assert.equal(row.caption, "Friday pour");
  } finally {
    cleanup();
  }
});

test("bulk delete purge capability is not reintroduced by backfill", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0017`, abv: 45 });
  const id = Number(spirit.id);
  const token = createTestAdminToken();
  try {
    const purge = await app.inject({
      method: "POST",
      url: "/api/inventory/purge",
      headers: { authorization: `Bearer ${token}` },
      payload: { window: "all", confirm: "DELETE" }
    });
    assert.notEqual(purge.statusCode, 200);
    assert.ok(db.prepare("SELECT id FROM spirits WHERE id=?").get(id));
  } finally {
    cleanup();
  }
});

test("audit event records backfill request without secrets", () => {
  cleanup();
  insertSpirit({ upc: `${PREFIX}0018`, abv: 0 });
  try {
    const result = queueEnrichmentBackfill({ types: ["metadata"] });
    assert.ok(result.auditId > 0);
    const audit = getLatestAdminAuditEvent("enrichment_backfill");
    assert.ok(audit);
    assert.equal(audit!.action_type, "enrichment_backfill");
    const serialized = JSON.stringify(audit!.detail);
    assert.equal(serialized.includes("PIN"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.ok(typeof audit!.detail.queued === "object");
    assert.ok(typeof audit!.created_at === "string");
  } finally {
    cleanup();
  }
});

test("existing enrichment merge behavior remains unchanged after backfill queue only", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}0019`, abv: 45 });
  const id = Number(spirit.id);
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Canonical official copy.",
    officialSourceUrl: "https://producer.example/x",
    officialSourceType: "official",
    houseProfile: "Canonical house profile."
  });
  try {
    queueEnrichmentBackfill();
    const content = getProductContent("spirits", id);
    assert.equal(content?.official_tasting_notes, "Canonical official copy.");
    assert.equal(content?.house_tasting_profile, "Canonical house profile.");
  } finally {
    cleanup();
  }
});
