/**
 * Admin enrichment review mutations require admin session; patrons stay read-only on canonical data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { saveToCache } from "./ingestion/catalogs/cola-cache-store.js";
import {
  clearEnrichmentJobsForTests,
  clearFieldOverridesForTests,
  clearReviewAuditForTests
} from "./ingestion/jobs/index.js";

const { app, createTestAdminToken } = await import("./server.js");

const UPC = "080244550001";

function insertSpirit() {
  return Number(
    db
      .prepare(
        `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc)
         VALUES ('Vault Name', 'Vault Brand', 'Bourbon', 45, 750, ?)`
      )
      .run(UPC).lastInsertRowid
  );
}

function seedConflict() {
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
}

function cleanup(id?: number) {
  clearEnrichmentJobsForTests();
  clearFieldOverridesForTests();
  clearReviewAuditForTests();
  if (id) db.prepare("DELETE FROM spirits WHERE id=?").run(id);
  db.prepare(`DELETE FROM spirits WHERE upc=?`).run(UPC);
  db.prepare(`DELETE FROM cola_cache WHERE upc=?`).run(UPC);
  db.prepare(`DELETE FROM reviews WHERE table_name='spirits'`).run();
}

test("unauthorized user cannot resolve a conflict", async () => {
  cleanup();
  const id = insertSpirit();
  seedConflict();
  const res = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/enrichment/resolve-conflict`,
    payload: { field: "name", choice: "keep" }
  });
  assert.equal(res.statusCode, 401);
  cleanup(id);
});

test("unauthorized user cannot verify a field", async () => {
  cleanup();
  const id = insertSpirit();
  const res = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/enrichment/verify-field`,
    payload: { field: "abv" }
  });
  assert.equal(res.statusCode, 401);
  cleanup(id);
});

test("unauthorized user cannot rerun enrichment", async () => {
  cleanup();
  const id = insertSpirit();
  const res = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/enrichment/rerun`,
    payload: { jobType: "metadata" }
  });
  assert.equal(res.statusCode, 401);
  cleanup(id);
});

test("public bottle enrichment detail remains readable", async () => {
  cleanup();
  const id = insertSpirit();
  const res = await app.inject({
    method: "GET",
    url: `/api/inventory/spirits/${id}/enrichment`
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { entityId: number; audit: unknown[]; verifiedFields: unknown[] };
  assert.equal(body.entityId, id);
  assert.ok(Array.isArray(body.audit));
  assert.ok(Array.isArray(body.verifiedFields));
  assert.equal(JSON.stringify(body).includes("pinHash"), false);
  assert.equal(JSON.stringify(body).includes("ADMIN_PIN"), false);
  cleanup(id);
});

test("admin resolve/verify/rerun succeed and record audit without secrets", async () => {
  cleanup();
  const id = insertSpirit();
  seedConflict();
  const token = createTestAdminToken();

  const resolve = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/enrichment/resolve-conflict`,
    headers: { authorization: `Bearer ${token}` },
    payload: { field: "brand", choice: "accept" }
  });
  assert.equal(resolve.statusCode, 200);
  const resolved = resolve.json() as {
    value: string;
    confidence: number;
    view: { identity: { brand: { value: string; sourceLabel: string } }; audit: Array<{ action: string }> };
  };
  assert.equal(resolved.value, "COLA Brand");
  assert.equal(resolved.view.identity.brand.value, "COLA Brand");
  assert.equal(resolved.view.identity.brand.sourceLabel, "User");
  assert.ok(resolved.view.audit.some((a) => a.action === "resolve_accept"));

  const verify = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/enrichment/verify-field`,
    headers: { authorization: `Bearer ${token}` },
    payload: { field: "abv" }
  });
  assert.equal(verify.statusCode, 200);
  assert.equal((verify.json() as { value: number }).value, 45);

  const rerun = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/enrichment/rerun`,
    headers: { authorization: `Bearer ${token}` },
    payload: { jobType: "metadata" }
  });
  assert.equal(rerun.statusCode, 200);
  assert.equal((rerun.json() as { created: boolean; job: { status: string } }).created, true);
  assert.equal((rerun.json() as { job: { status: string } }).job.status, "pending");

  const raw = `${resolve.body}${verify.body}${rerun.body}`;
  assert.equal(raw.includes("pinHash"), false);
  assert.equal(raw.includes("ADMIN_PIN"), false);
  assert.equal(raw.includes("SESSION_SECRET"), false);
  cleanup(id);
});

test("patron review submission still works alongside admin enrichment actions", async () => {
  cleanup();
  const id = insertSpirit();
  const review = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${id}/reviews`,
    payload: { author: "Sam", body: "Still a great pour after enrichment review actions." }
  });
  assert.equal(review.statusCode, 201);
  cleanup(id);
});

test("patron gallery photo upload still works", async () => {
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
    "base64"
  );
  const boundary = "----reviewactionsboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="n.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
    ),
    jpeg,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="uploaded_by"\r\n\r\nAlex\r\n--${boundary}--\r\n`
    )
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/gallery/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body
  });
  assert.equal(res.statusCode, 201, res.body);
  db.prepare("DELETE FROM gallery_media WHERE id=?").run((res.json() as { id: number }).id);
});
