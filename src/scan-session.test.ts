/**
 * Admin shelf scan-session save/undo pipeline and duplicate cooldown helpers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import { db } from "./db.js";
import { clearEnrichmentJobsForTests } from "./ingestion/jobs/index.js";
import {
  saveScanSessionBottle,
  SCAN_DUPLICATE_COOLDOWN_MS,
  shouldSuppressDuplicateScan,
  undoScanSessionMutation
} from "./scan-session.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");

const PREFIX = "0806870";

/** Minimal valid JPEG (1x1). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64"
);

function cleanup() {
  clearEnrichmentJobsForTests();
  db.prepare("DELETE FROM reviews WHERE table_name='spirits'").run();
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare("DELETE FROM import_queue WHERE upc LIKE '" + PREFIX + "%'").run();
}

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const upc = `${PREFIX}001`;
  const row = {
    name: "Session Spirit",
    brand: "Session Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc,
    stock_count: 1,
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, stock_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc, row.stock_count);
  return { id: Number(result.lastInsertRowid), upc, ...row };
}

test("unauthorized user cannot use scan-session save or undo", async () => {
  cleanup();
  try {
    const save = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/scan-session/save",
      payload: { code: `${PREFIX}999`, kind: "spirits" }
    });
    assert.equal(save.statusCode, 401);

    const undo = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/scan-session/undo",
      payload: { table: "spirits", id: 1, action: "added", snapshot: { name: "X" } }
    });
    assert.equal(undo.statusCode, 401);
  } finally {
    cleanup();
  }
});

test("admin session can save a scanned bottle immediately", async () => {
  cleanup();
  const upc = `${PREFIX}002`;
  saveBarcodeCacheEntry({
    upc,
    name: "Session Add Bottle",
    brand: "Add Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    source: "ai"
  });
  const token = createTestAdminToken();
  try {
    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/scan-session/save",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: upc, kind: "spirits" }
    });
    assert.equal(res.statusCode, 200);
    assert.ok(Date.now() - started < 500);
    const body = res.json() as { action: string; name: string; upc: string };
    assert.equal(body.action, "added");
    assert.equal(body.name, "Session Add Bottle");
    const row = db.prepare("SELECT name FROM spirits WHERE upc=?").get(body.upc) as { name: string };
    assert.equal(row.name, "Session Add Bottle");
  } finally {
    cleanup();
  }
});

test("successful scan save does not wait for enrichment execution", async () => {
  cleanup();
  const upc = `${PREFIX}003`;
  saveBarcodeCacheEntry({
    upc,
    name: "Session Queue Bottle",
    brand: "Queue Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    source: "ai"
  });
  try {
    const result = await saveScanSessionBottle({ code: upc, kind: "spirits" });
    assert.equal(result.action, "added");
    assert.equal(result.enrichmentQueued, true);
    const job = db.prepare(`
      SELECT status FROM enrichment_jobs WHERE entity_type='spirits' AND job_type='metadata' ORDER BY id DESC LIMIT 1
    `).get() as { status: string } | undefined;
    assert.equal(job?.status, "pending");
  } finally {
    cleanup();
  }
});

test("existing vault UPC increments stock_count instead of creating duplicate row", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}004`, stock_count: 2 });
  try {
    const result = await saveScanSessionBottle({ code: spirit.upc, kind: "spirits" });
    assert.equal(result.action, "updated");
    assert.equal(result.quantityBefore, 2);
    assert.equal(result.quantityAfter, 3);
    const count = db.prepare("SELECT COUNT(*) AS n FROM spirits WHERE upc=?").get(spirit.upc) as { n: number };
    assert.equal(count.n, 1);
    const row = db.prepare("SELECT stock_count FROM spirits WHERE id=?").get(spirit.id) as { stock_count: number };
    assert.equal(row.stock_count, 3);
  } finally {
    cleanup();
  }
});

test("duplicate cooldown suppresses immediate rescans", () => {
  const upc = `${PREFIX}005`;
  assert.equal(shouldSuppressDuplicateScan(upc, upc, 1000, 1000 + SCAN_DUPLICATE_COOLDOWN_MS - 1), true);
  assert.equal(shouldSuppressDuplicateScan(upc, upc, 1000, 1000 + SCAN_DUPLICATE_COOLDOWN_MS), false);
  assert.equal(shouldSuppressDuplicateScan(upc, `${PREFIX}006`, 1000, 1500), false);
});

test("unknown barcode returns needs_review without blocking later scans", async () => {
  cleanup();
  try {
    const first = await saveScanSessionBottle({ code: "not-a-barcode", kind: "spirits" });
    assert.equal(first.action, "needs_review");
    saveBarcodeCacheEntry({
      upc: `${PREFIX}007`,
      name: "Later Bottle",
      brand: "Later Brand",
      category: "Bourbon",
      abv: 45,
      volume_ml: 750,
      source: "ai"
    });
    const second = await saveScanSessionBottle({ code: `${PREFIX}007`, kind: "spirits" });
    assert.equal(second.action, "added");
  } finally {
    cleanup();
  }
});

test("undo last added scan removes the created bottle", async () => {
  cleanup();
  const upc = `${PREFIX}008`;
  saveBarcodeCacheEntry({
    upc,
    name: "Undo Add Bottle",
    brand: "Undo Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    source: "ai"
  });
  try {
    const saved = await saveScanSessionBottle({ code: upc, kind: "spirits" });
    assert.equal(saved.action, "added");
    assert.ok(saved.undo);
    const undone = undoScanSessionMutation(saved.undo!);
    assert.equal(undone.ok, true);
    assert.equal(db.prepare("SELECT id FROM spirits WHERE upc=?").get(upc), undefined);
  } finally {
    cleanup();
  }
});

test("undo last updated scan restores previous quantity", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}009`, stock_count: 4 });
  try {
    const saved = await saveScanSessionBottle({ code: spirit.upc, kind: "spirits" });
    assert.equal(saved.action, "updated");
    assert.ok(saved.undo);
    undoScanSessionMutation(saved.undo!);
    const row = db.prepare("SELECT stock_count FROM spirits WHERE id=?").get(spirit.id) as { stock_count: number };
    assert.equal(row.stock_count, 4);
  } finally {
    cleanup();
  }
});

test("patron review submission remains unchanged after scan-session save", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}010` });
  const token = createTestAdminToken();
  try {
    await app.inject({
      method: "POST",
      url: "/api/admin/inventory/scan-session/save",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: spirit.upc, kind: "spirits" }
    });
    const review = await app.inject({
      method: "POST",
      url: `/api/inventory/spirits/${spirit.id}/reviews`,
      payload: { author: "Patron", body: "Still works." }
    });
    assert.equal(review.statusCode, 201);
  } finally {
    cleanup();
  }
});

test("patron gallery upload remains unchanged after scan-session save", async () => {
  cleanup();
  insertSpirit({ upc: `${PREFIX}011` });
  const token = createTestAdminToken();
  const boundary = "----scanSessionGallery";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="night.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`
    ),
    TINY_JPEG,
    Buffer.from(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\nPour\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="uploaded_by"\r\n\r\nAlex\r\n` +
        `--${boundary}--\r\n`
    )
  ]);
  try {
    await app.inject({
      method: "POST",
      url: "/api/admin/inventory/scan-session/save",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: `${PREFIX}011`, kind: "spirits" }
    });
    const upload = await app.inject({
      method: "POST",
      url: "/api/gallery/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body
    });
    assert.equal(upload.statusCode, 201);
  } finally {
    cleanup();
  }
});

test("scan session does not reintroduce bulk purge capability", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}012` });
  const token = createTestAdminToken();
  try {
    const purge = await app.inject({
      method: "POST",
      url: "/api/inventory/purge",
      headers: { authorization: `Bearer ${token}` },
      payload: { window: "all", confirm: "DELETE" }
    });
    assert.notEqual(purge.statusCode, 200);
    assert.ok(db.prepare("SELECT id FROM spirits WHERE id=?").get(spirit.id));
  } finally {
    cleanup();
  }
});

test("manual save endpoint uses same pipeline as scanned code", async () => {
  cleanup();
  const upc = `${PREFIX}013`;
  saveBarcodeCacheEntry({
    upc,
    name: "Manual Pipeline Bottle",
    brand: "Manual Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    source: "ai"
  });
  const token = createTestAdminToken();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/scan-session/save",
      headers: { authorization: `Bearer ${token}` },
      payload: { code: upc, kind: "spirits" }
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { action: string }).action, "added");
  } finally {
    cleanup();
  }
});
