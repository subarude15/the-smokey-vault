/**
 * Patron community features must stay available alongside enrichment read-only rules.
 * Reviews + gallery uploads remain public; they must not mutate canonical product data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { getProductContent, upsertProductContent } from "./ingestion/jobs/product-content.js";
import { getProductImage, upsertProductImage } from "./ingestion/jobs/product-images.js";
import { buildBottleEnrichmentView } from "./ingestion/jobs/enrichment-view.js";

const { app, createTestAdminToken } = await import("./server.js");

/** Minimal valid JPEG (1x1). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64"
);

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Patron Community Bottle",
    brand: "Canonical Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc: "080244990001",
    notes: "Keeper cellar note",
    tasting_notes: "Keeper personal tasting",
    image_url: "",
    ...overrides
  };
  const result = db
    .prepare(
      `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
  return Number(result.lastInsertRowid);
}

function snapshotCanonical(id: number) {
  const spirit = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  const content = getProductContent("spirits", id);
  const image = getProductImage("spirits", id);
  return {
    name: spirit.name,
    brand: spirit.brand,
    category: spirit.category,
    abv: spirit.abv,
    volume_ml: spirit.volume_ml,
    upc: spirit.upc,
    notes: spirit.notes,
    tasting_notes: spirit.tasting_notes,
    image_url: spirit.image_url,
    official: content?.official_tasting_notes ?? null,
    house: content?.house_tasting_profile ?? null,
    productImageUrl: image?.url ?? null,
    productImageVerified: image?.verified ?? null
  };
}

test("existing patron review submission still works without admin session", async () => {
  const id = insertSpirit();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/inventory/spirits/${id}/reviews`,
      payload: { author: "Sam", body: "Bright caramel and a clean finish." }
    });
    assert.equal(res.statusCode, 201);
    const review = res.json() as { author: string; body: string };
    assert.equal(review.author, "Sam");
    assert.match(review.body, /caramel/i);

    const listed = await app.inject({
      method: "GET",
      url: `/api/inventory/spirits/${id}/reviews`
    });
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as unknown[]).length, 1);
  } finally {
    db.prepare("DELETE FROM reviews WHERE table_name='spirits' AND item_id=?").run(id);
    db.prepare("DELETE FROM spirits WHERE id=?").run(id);
  }
});

test("existing patron gallery photo upload still works without admin session", async () => {
  const boundary = "----patronboundary7MA4YWxkTrZu0gW";
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
  const res = await app.inject({
    method: "POST",
    url: "/api/gallery/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body
  });
  assert.equal(res.statusCode, 201, res.body);
  const media = res.json() as { uploaded_by: string; caption: string; id: number; url: string };
  assert.equal(media.uploaded_by, "Alex");
  assert.equal(media.caption, "Friday pour");
  assert.ok(media.url.includes("/api/media/gallery/"));
  db.prepare("DELETE FROM gallery_media WHERE id=?").run(media.id);
});

test("patron review does not mutate canonical inventory or enrichment content", async () => {
  const id = insertSpirit();
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Official producer copy.",
    officialSourceUrl: "https://producer.example/bottle",
    officialSourceType: "official",
    houseProfile: "AI house profile copy."
  });
  upsertProductImage({
    entityType: "spirits",
    entityId: id,
    url: "https://cdn.example/canonical.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/bottle",
    score: 90,
    verified: true
  });
  const before = snapshotCanonical(id);

  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/inventory/spirits/${id}/reviews`,
      payload: {
        author: "Patron",
        body: "Trying to overwrite official tasting notes via review body."
      }
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(snapshotCanonical(id), before);

    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!;
    assert.equal(view.tastingNotes.official, "Official producer copy.");
    assert.equal(view.tastingNotes.houseProfile, "AI house profile copy.");
    assert.equal(view.tastingNotes.personal, "Keeper personal tasting");
    assert.notEqual(view.tastingNotes.official, view.tastingNotes.personal);
  } finally {
    db.prepare("DELETE FROM reviews WHERE table_name='spirits' AND item_id=?").run(id);
    db.prepare("DELETE FROM product_content WHERE entity_type='spirits' AND entity_id=?").run(id);
    db.prepare("DELETE FROM product_images WHERE entity_type='spirits' AND entity_id=?").run(id);
    db.prepare("DELETE FROM spirits WHERE id=?").run(id);
  }
});

test("patron gallery photo does not replace canonical product or shelf image", async () => {
  const id = insertSpirit({
    image_url: "https://vault.example/user-shelf.jpg"
  });
  upsertProductImage({
    entityType: "spirits",
    entityId: id,
    url: "https://cdn.example/enriched-canonical.jpg",
    sourceType: "official",
    sourceUrl: "https://producer.example/x",
    score: 88,
    verified: true
  });
  const before = snapshotCanonical(id);

  const boundary = "----patronboundaryCanonical";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="party.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`
    ),
    TINY_JPEG,
    Buffer.from(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\nBar night\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="uploaded_by"\r\n\r\nJordan\r\n` +
        `--${boundary}--\r\n`
    )
  ]);
  const upload = await app.inject({
    method: "POST",
    url: "/api/gallery/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const media = upload.json() as { id: number };

  try {
    assert.deepEqual(snapshotCanonical(id), before);
    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!;
    assert.equal(view.image.userPreferred, true);
    assert.equal(view.image.displayUrl, "https://vault.example/user-shelf.jpg");
    assert.equal(view.image.enrichedUrl, "https://cdn.example/enriched-canonical.jpg");
    assert.notEqual(view.image.displayUrl, (upload.json() as { url: string }).url);
  } finally {
    db.prepare("DELETE FROM gallery_media WHERE id=?").run(media.id);
    db.prepare("DELETE FROM product_images WHERE entity_type='spirits' AND entity_id=?").run(id);
    db.prepare("DELETE FROM spirits WHERE id=?").run(id);
  }
});

test("existing admin/PIN inventory mutation behavior remains unchanged", async () => {
  const token = createTestAdminToken();
  const denied = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    payload: { name: "Nope", brand: "X", category: "Rum", abv: 40, volume_ml: 750 }
  });
  assert.equal(denied.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Admin Still Works",
      brand: "Keeper",
      category: "Bourbon",
      abv: 46,
      volume_ml: 750,
      upc: "080244990002"
    }
  });
  assert.equal(created.statusCode, 201);
  const row = created.json() as { id: number };

  const review = await app.inject({
    method: "POST",
    url: `/api/inventory/spirits/${row.id}/reviews`,
    payload: { author: "Guest", body: "Still can review after admin create." }
  });
  assert.equal(review.statusCode, 201);

  await app.inject({
    method: "DELETE",
    url: `/api/inventory/spirits/${row.id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  db.prepare("DELETE FROM spirits WHERE upc IN ('080244990001','080244990002')").run();
});

test("bottle inventory photo upload endpoint stays admin-gated (canonical image path)", async () => {
  const boundary = "----invphoto";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="bottle.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`
    ),
    TINY_JPEG,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const guest = await app.inject({
    method: "POST",
    url: "/api/media/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body
  });
  assert.equal(guest.statusCode, 401);

  const token = createTestAdminToken();
  const admin = await app.inject({
    method: "POST",
    url: "/api/media/upload",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload: body
  });
  assert.equal(admin.statusCode, 200);
  assert.ok((admin.json() as { url: string }).url.startsWith("/api/media/images/"));
});
