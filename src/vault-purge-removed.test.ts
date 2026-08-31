/**
 * Regression: bulk "Empty the vault" purge was removed; normal inventory flows stay intact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { pinAccepted, isAdmin } = await import("./auth.js");
const { db, setPin, verifyPin } = await import("./db.js");
const { sessionSecret } = await import("./server.js");
const { maybeEnqueueMetadataEnrichment } = await import("./ingestion/jobs/index.js");

const UPC = "080244880002";

/** Minimal valid JPEG (1x1). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64"
);

function cleanup(id?: number) {
  if (id) db.prepare("DELETE FROM spirits WHERE id=?").run(id);
  db.prepare("DELETE FROM spirits WHERE upc=?").run(UPC);
  db.prepare("DELETE FROM enrichment_jobs WHERE upc=?").run(UPC);
  db.prepare("DELETE FROM reviews WHERE table_name='spirits'").run();
  setPin(process.env.DEFAULT_PIN ?? "1234");
  delete process.env.ADMIN_PIN;
}

test("GET /api/inventory/purge no longer exists", async () => {
  const token = createTestAdminToken();
  for (const auth of [undefined, `Bearer ${token}`] as const) {
    const res = await app.inject({
      method: "GET",
      url: "/api/inventory/purge?window=all",
      headers: auth ? { authorization: auth } : {}
    });
    assert.equal(res.statusCode, 404, auth ? "even with admin" : "without admin");
    assert.equal((res.json() as { error: string }).error, "Unknown module");
    assert.equal(res.body.includes("spirits"), false, "must not return purge preview counts");
  }
});

test("POST /api/inventory/purge no longer exists", async () => {
  const token = createTestAdminToken();
  const unauth = await app.inject({
    method: "POST",
    url: "/api/inventory/purge",
    payload: { window: "all", confirm: "DELETE" }
  });
  assert.equal(unauth.statusCode, 401, "generic inventory create requires admin");

  const authed = await app.inject({
    method: "POST",
    url: "/api/inventory/purge",
    headers: { authorization: `Bearer ${token}` },
    payload: { window: "all", confirm: "DELETE" }
  });
  assert.equal(authed.statusCode, 404);
  assert.equal((authed.json() as { error: string }).error, "Unknown module");
});

test("no bulk delete-all-shelf API remains after seeding inventory", async () => {
  cleanup();
  const token = createTestAdminToken();
  const create = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Purge Guard Bottle",
      brand: "Guard",
      category: "Bourbon",
      abv: 45,
      volume_ml: 750,
      upc: UPC
    }
  });
  assert.equal(create.statusCode, 201);
  const id = (create.json() as { id: number }).id;

  try {
    const before = db.prepare("SELECT COUNT(*) AS c FROM spirits").get() as { c: number };
    assert.ok(before.c >= 1);

    const purge = await app.inject({
      method: "POST",
      url: "/api/inventory/purge",
      headers: { authorization: `Bearer ${token}` },
      payload: { window: "all", confirm: "DELETE" }
    });
    assert.equal(purge.statusCode, 404);

    const after = db.prepare("SELECT COUNT(*) AS c FROM spirits").get() as { c: number };
    assert.equal(after.c, before.c, "purge route must not remove shelf bottles");

    const row = db.prepare("SELECT name FROM spirits WHERE id=?").get(id) as { name: string };
    assert.equal(row.name, "Purge Guard Bottle");
  } finally {
    await app.inject({
      method: "DELETE",
      url: `/api/inventory/spirits/${id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    cleanup(id);
  }
});

test("individual inventory add, update, and delete still work for authorized keepers", async () => {
  cleanup();
  const token = createTestAdminToken();

  const create = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Individual CRUD Bottle",
      brand: "Keeper",
      category: "Rye",
      abv: 46,
      volume_ml: 750,
      upc: UPC
    }
  });
  assert.equal(create.statusCode, 201);
  const id = (create.json() as { id: number }).id;

  try {
    const update = await app.inject({
      method: "PUT",
      url: `/api/inventory/spirits/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: "Cellar note" }
    });
    assert.equal(update.statusCode, 200);
    assert.equal((update.json() as { notes: string }).notes, "Cellar note");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/inventory/spirits/${id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(del.statusCode, 204);
    assert.equal(db.prepare("SELECT id FROM spirits WHERE id=?").get(id), undefined);
  } finally {
    cleanup(id);
  }
});

test("admin PIN unlock and session authorization remain unchanged", async () => {
  cleanup();
  setPin("4242");
  assert.equal(verifyPin("4242"), true);
  assert.equal(pinAccepted("4242"), true);

  const unlock = await app.inject({
    method: "POST",
    url: "/api/auth/unlock",
    payload: { pin: "4242" }
  });
  assert.equal(unlock.statusCode, 200);
  const token = (unlock.json() as { token: string }).token;
  assert.equal(isAdmin(`Bearer ${token}`, sessionSecret), true);

  const denied = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    payload: { name: "No Auth", brand: "X", category: "Rum", abv: 40, volume_ml: 750 }
  });
  assert.equal(denied.statusCode, 401);

  cleanup();
});

test("patron review and gallery upload flows remain unchanged", async () => {
  cleanup();
  const id = Number(
    db
      .prepare(
        `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("Patron Flow Bottle", "Brand", "Bourbon", 45, 750, UPC, "note", "tasting").lastInsertRowid
  );

  try {
    const review = await app.inject({
      method: "POST",
      url: `/api/inventory/spirits/${id}/reviews`,
      payload: { author: "Jordan", body: "Smooth and oaky." }
    });
    assert.equal(review.statusCode, 201);

    const boundary = "----purgeRemovedBoundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="pour.jpg"\r\n` +
          `Content-Type: image/jpeg\r\n\r\n`
      ),
      TINY_JPEG,
      Buffer.from(
        `\r\n--${boundary}\r\n` +
          `Content-Disposition: form-data; name="caption"\r\n\r\nAfter work\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="uploaded_by"\r\n\r\nJordan\r\n` +
          `--${boundary}--\r\n`
      )
    ]);
    const gallery = await app.inject({
      method: "POST",
      url: "/api/gallery/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body
    });
    assert.equal(gallery.statusCode, 201, gallery.body);
    const media = gallery.json() as { id: number };
    db.prepare("DELETE FROM gallery_media WHERE id=?").run(media.id);
  } finally {
    db.prepare("DELETE FROM reviews WHERE table_name='spirits' AND item_id=?").run(id);
    cleanup(id);
  }
});

test("enrichment queue enqueue behavior remains unchanged", async () => {
  cleanup();
  const id = Number(
    db
      .prepare(
        `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run("Enrichment Queue Bottle", "Brand", "Bourbon", 45, 750, UPC, "note", "tasting").lastInsertRowid
  );

  try {
    const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
    const result = maybeEnqueueMetadataEnrichment({
      entityType: "spirits",
      entityId: id,
      row
    });
    assert.equal(result.enqueued, true);
    const job = db
      .prepare(
        `SELECT job_type, status FROM enrichment_jobs WHERE entity_type='spirits' AND entity_id=? AND job_type='metadata'`
      )
      .get(id) as { job_type: string; status: string };
    assert.equal(job.job_type, "metadata");
    assert.equal(job.status, "pending");
  } finally {
    cleanup(id);
  }
});
