/**
 * PR138 — Keg beer image reliability + Keeper upload rendering.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const root = dirname(fileURLToPath(import.meta.url));
const { db } = await import("./db.js");
const {
  canonicalizeLocalImageUrl,
  isLocalImagePath,
  saveImageBuffer
} = await import("./images.js");
const {
  isLocalMediaValue,
  settleMediaUpload,
  toStoredMediaValue
} = await import("../client/src/ImageField.tsx");
const { app, createTestAdminToken } = await import("./server.js");

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function resetTap(tapNumber: number) {
  db.prepare(
    `UPDATE taps SET
      brewery_batch='', maker='', style='', abv=0, ibu=0, tapped_date=NULL,
      remaining_l=0, notes='', tasting_notes='', image_url='', flavors='[]', tags='[]',
      source_type='Commercial', updated_at=CURRENT_TIMESTAMP
     WHERE tap_number=?`
  ).run(tapNumber);
}

afterEach(() => {
  resetTap(6);
});

test("canonicalizeLocalImageUrl keeps relative paths; absolute only when origin matches", () => {
  assert.equal(
    canonicalizeLocalImageUrl("/api/media/images/abc.jpg"),
    "/api/media/images/abc.jpg"
  );
  assert.equal(
    canonicalizeLocalImageUrl("http://localhost:8787/api/media/images/abc.jpg", {
      origin: "http://localhost:8787"
    }),
    "/api/media/images/abc.jpg"
  );
  assert.equal(
    canonicalizeLocalImageUrl("https://cdn.example.com/api/media/images/beer.jpg", {
      origin: "http://localhost:8787"
    }),
    null
  );
  // Absolute media path without a known app origin must stay remote.
  assert.equal(
    canonicalizeLocalImageUrl("http://localhost:8787/api/media/images/abc.jpg"),
    null
  );
  assert.equal(canonicalizeLocalImageUrl("https://cdn.example/beer.jpg"), null);
  assert.equal(isLocalImagePath("/api/media/images/abc.jpg"), true);
});

test("ImageField media helpers: same-origin collapses; foreign /api/media/images stays remote", () => {
  const origin = "https://vault.example";
  assert.equal(isLocalMediaValue("/api/media/images/abc.jpg", origin), true);
  assert.equal(toStoredMediaValue("/api/media/images/abc.jpg", origin), "/api/media/images/abc.jpg");
  assert.equal(
    toStoredMediaValue("https://vault.example/api/media/images/abc.jpg", origin),
    "/api/media/images/abc.jpg"
  );
  assert.equal(
    isLocalMediaValue("https://cdn.example.com/api/media/images/beer.jpg", origin),
    false
  );
  assert.equal(
    toStoredMediaValue("https://cdn.example.com/api/media/images/beer.jpg", origin),
    "https://cdn.example.com/api/media/images/beer.jpg"
  );

  const src = readFileSync(join(root, "../client/src/ImageField.tsx"), "utf8");
  assert.match(src, /export function isLocalMediaValue/);
  assert.match(src, /export function toStoredMediaValue/);
  assert.match(src, /export async function settleMediaUpload/);
  assert.match(src, /setShowUrl\(false\)/);
  assert.match(src, /blob:/);
  assert.match(src, /Leave parent form state untouched/);
  assert.match(src, /\/api\/media\/images\//);
  assert.match(src, /pathname\.startsWith\(LOCAL_MEDIA_PREFIX\)/);
  assert.equal(/onChange\(previous\)/.test(src), false);
  assert.equal(/previousValueRef/.test(src), false);
});

test("settleMediaUpload failure does not call onChange; newer success is not overwritten", async () => {
  const changes: string[] = [];
  const errors: string[] = [];

  let finishFirst!: (error?: Error) => void;
  const firstUpload = new Promise<{ url: string }>((resolve, reject) => {
    finishFirst = (error) => {
      if (error) reject(error);
      else resolve({ url: "/api/media/images/stale.jpg" });
    };
  });

  const first = settleMediaUpload(() => firstUpload, {
    onSuccess: (url) => changes.push(url),
    onFailure: (message) => errors.push(message),
    origin: "http://localhost"
  });

  await settleMediaUpload(
    async () => ({ url: "http://localhost/api/media/images/newer.jpg" }),
    {
      onSuccess: (url) => changes.push(url),
      onFailure: (message) => errors.push(message),
      origin: "http://localhost"
    }
  );

  finishFirst(new Error("upload timed out"));
  await first;

  assert.deepEqual(changes, ["/api/media/images/newer.jpg"]);
  assert.deepEqual(errors, ["upload timed out"]);
});

test("POST /api/media/upload + PUT tap stores local media path; card renders <img>", async () => {
  const token = createTestAdminToken();
  const boundary = "----PR138Boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="tap-phone.png"\r\nContent-Type: image/png\r\n\r\n`
    ),
    tinyPng,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const upload = await app.inject({
    method: "POST",
    url: "/api/media/upload",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const uploaded = upload.json() as { url: string };
  assert.ok(isLocalImagePath(uploaded.url));

  const tap = db.prepare("SELECT id FROM taps WHERE tap_number=6").get() as { id: number };
  db.prepare(
    `UPDATE taps SET maker=?, brewery_batch=?, source_type='Commercial', remaining_l=10 WHERE id=?`
  ).run("Victory Brewing Company", "DirtWolf", tap.id);

  const put = await app.inject({
    method: "PUT",
    url: `/api/inventory/taps/${tap.id}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    payload: {
      maker: "Victory Brewing Company",
      brewery_batch: "DirtWolf",
      image_url: uploaded.url
    }
  });
  assert.equal(put.statusCode, 200, put.body);
  const saved = put.json() as { image_url: string };
  assert.equal(saved.image_url, uploaded.url);

  const reload = await app.inject({
    method: "GET",
    url: "/api/inventory/taps",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(reload.statusCode, 200);
  const items = reload.json() as Array<{ id: number; image_url?: string }>;
  const row = items.find((item) => item.id === tap.id);
  assert.ok(row);
  assert.equal(row!.image_url, uploaded.url);

  const cardSrc = readFileSync(join(root, "../client/src/TapSpiritInventoryCard.tsx"), "utf8");
  assert.match(cardSrc, /<img src=\{src\} alt=\{label\}\/>/);
  assert.equal(/<a[^>]+href=\{src\}/.test(cardSrc), false);
});

test("same-origin absolute local media URL is canonicalized on tap update", async () => {
  const token = createTestAdminToken();
  const local = saveImageBuffer(tinyPng, "image/png", "abs-tap.png");
  const tap = db.prepare("SELECT id FROM taps WHERE tap_number=6").get() as { id: number };
  const put = await app.inject({
    method: "PUT",
    url: `/api/inventory/taps/${tap.id}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      host: "127.0.0.1:8787",
      "x-forwarded-proto": "http"
    },
    payload: {
      image_url: `http://127.0.0.1:8787${local}`
    }
  });
  assert.equal(put.statusCode, 200, put.body);
  const saved = put.json() as { image_url: string };
  assert.equal(saved.image_url, local);
});

test("different-origin absolute /api/media/images URL is not collapsed on tap update", async () => {
  const token = createTestAdminToken();
  const tap = db.prepare("SELECT id FROM taps WHERE tap_number=6").get() as { id: number };
  const remote = "https://cdn.example.com/api/media/images/beer.jpg";
  const put = await app.inject({
    method: "PUT",
    url: `/api/inventory/taps/${tap.id}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      host: "localhost:80"
    },
    payload: {
      // localizeImage will fail (no network fixture) and leave the remote URL.
      image_url: remote
    }
  });
  assert.equal(put.statusCode, 200, put.body);
  const saved = put.json() as { image_url: string };
  assert.equal(saved.image_url, remote);
  assert.equal(isLocalImagePath(saved.image_url), false);
});

test("phone-oriented image MIME types remain accepted by saveImageBuffer allowlist", () => {
  assert.ok(saveImageBuffer(tinyPng, "image/png", "phone.png").startsWith("/api/media/images/"));
  const imagesSrc = readFileSync(join(root, "images.ts"), "utf8");
  assert.match(imagesSrc, /image\/heic/);
  assert.match(imagesSrc, /image\/jpeg/);
  assert.match(imagesSrc, /image\/webp/);
});
