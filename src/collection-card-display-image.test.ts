/**
 * Collection cards must consume the same display_image_url already attached
 * for bottle detail (PR #86). This is display wiring only — no enrichment,
 * persistence, or inventory.image_url semantic changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import {
  attachInventoryDisplayImageUrl,
  clearProductImagesForTests,
  resolveInventoryDisplayImageUrl,
  upsertProductImage
} from "./ingestion/jobs/index.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app } = await import("./server.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");

const KORBEL_UPC = "084704098044";
const CAPTAIN_UPC = "087000201156";
const KORBEL_LOCAL = "/api/media/images/korbel-sweet-cuvee.jpg";
const CAPTAIN_LOCAL = "/api/media/images/captain-morgan-original.jpg";
const USER_LOCAL = "/api/media/images/user-shelf.jpg";
const LEGACY_LOCAL = "/api/media/images/legacy-shelf.jpg";

function cleanup() {
  clearProductImagesForTests();
  db.prepare("DELETE FROM wines WHERE upc = ? OR name LIKE 'CardDisplay%'").run(KORBEL_UPC);
  db.prepare("DELETE FROM spirits WHERE upc = ? OR name LIKE 'CardDisplay%'").run(CAPTAIN_UPC);
  db.prepare("DELETE FROM packaged_beer WHERE name LIKE 'CardDisplay%'").run();
}

function insertWine(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Korbel Sweet Cuvee California Champagne",
    producer: "Korbel",
    type: "Sparkling",
    style: "Champagne",
    vintage: null as number | null,
    upc: KORBEL_UPC,
    image_url: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO wines (name, producer, type, style, vintage, upc, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    row.producer,
    row.type,
    row.style,
    row.vintage,
    row.upc,
    row.image_url
  );
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM wines WHERE id=?").get(id) as Record<string, unknown>;
}

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    category: "Rum",
    abv: 35,
    volume_ml: 750,
    upc: CAPTAIN_UPC,
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

function seedAccepted(entityType: "spirits" | "wines" | "packaged_beer", entityId: number, url: string) {
  upsertProductImage({
    entityType,
    entityId,
    url,
    sourceType: "approved",
    sourceUrl: "https://producer.example/product",
    width: 1200,
    height: 1600,
    mimeType: "image/jpeg",
    score: 75,
    verified: true,
    rejectionReason: null
  });
}

/** Client helper mirrored by collection cards / bottle detail. */
function cardImageSrc(item: { display_image_url?: unknown; image_url?: unknown }): string {
  return String(item.display_image_url ?? item.image_url ?? "").trim();
}

test("collection inventory cards prefer display_image_url over image_url", () => {
  // Scope to the inventory collection card-icon block (shared spirits/wines/packaged_beer grid).
  const marker = "inventory-card inventory-card-button";
  const idx = appSrc.indexOf(marker);
  assert.ok(idx >= 0, "inventory collection card markup present");
  const slice = appSrc.slice(idx, idx + 1200);
  assert.match(
    slice,
    /display_image_url\s*\?\?\s*item\.image_url/,
    "collection card-icon must prefer display_image_url with image_url fallback"
  );
  assert.doesNotMatch(
    slice,
    /card-icon">\{item\.image_url \?/,
    "collection cards must not read image_url alone"
  );
});

test("bottle detail still uses the same display_image_url precedence", () => {
  assert.match(
    appSrc,
    /display_image_url\s*\?\?\s*item\.image_url/,
    "detail hero must keep display_image_url ?? image_url"
  );
});

test("A. wine card uses enriched display_image_url fallback", async () => {
  cleanup();
  const wine = insertWine({ name: "CardDisplay Korbel", image_url: "" });
  seedAccepted("wines", Number(wine.id), KORBEL_LOCAL);

  const res = await app.inject({ method: "GET", url: "/api/inventory/wines" });
  assert.equal(res.statusCode, 200);
  const rows = res.json() as Array<Record<string, unknown>>;
  const item = rows.find((r) => Number(r.id) === Number(wine.id));
  assert.ok(item);
  assert.equal(item!.image_url, "");
  assert.equal(item!.display_image_url, KORBEL_LOCAL);
  assert.equal(cardImageSrc(item!), KORBEL_LOCAL);
  assert.notEqual(cardImageSrc(item!), "");
  cleanup();
});

test("B. spirit card uses enriched display_image_url fallback", async () => {
  cleanup();
  const spirit = insertSpirit({ name: "CardDisplay Captain", image_url: "" });
  seedAccepted("spirits", Number(spirit.id), CAPTAIN_LOCAL);

  const res = await app.inject({ method: "GET", url: "/api/inventory/spirits" });
  assert.equal(res.statusCode, 200);
  const rows = res.json() as Array<Record<string, unknown>>;
  const item = rows.find((r) => Number(r.id) === Number(spirit.id));
  assert.ok(item);
  assert.equal(item!.image_url, "");
  assert.equal(item!.display_image_url, CAPTAIN_LOCAL);
  assert.equal(cardImageSrc(item!), CAPTAIN_LOCAL);
  cleanup();
});

test("C. user image still wins on collection responses", async () => {
  cleanup();
  const spirit = insertSpirit({
    name: "CardDisplay UserWins",
    image_url: USER_LOCAL
  });
  seedAccepted("spirits", Number(spirit.id), CAPTAIN_LOCAL);

  const res = await app.inject({ method: "GET", url: "/api/inventory/spirits" });
  const item = (res.json() as Array<Record<string, unknown>>).find(
    (r) => Number(r.id) === Number(spirit.id)
  );
  assert.ok(item);
  assert.equal(item!.image_url, USER_LOCAL);
  assert.equal(item!.display_image_url, USER_LOCAL);
  assert.equal(cardImageSrc(item!), USER_LOCAL);
  cleanup();
});

test("D. no image keeps empty card src (placeholder path)", async () => {
  cleanup();
  const wine = insertWine({ name: "CardDisplay NoImage", upc: "084704099999", image_url: "" });

  const res = await app.inject({ method: "GET", url: "/api/inventory/wines" });
  const item = (res.json() as Array<Record<string, unknown>>).find(
    (r) => Number(r.id) === Number(wine.id)
  );
  assert.ok(item);
  assert.equal(item!.display_image_url ?? null, null);
  assert.equal(cardImageSrc(item!), "");
  cleanup();
});

test("E. legacy image_url fallback when display_image_url is absent", () => {
  const legacyItem = { image_url: LEGACY_LOCAL };
  assert.equal(cardImageSrc(legacyItem), LEGACY_LOCAL);

  const nullDisplay = { display_image_url: null, image_url: LEGACY_LOCAL };
  assert.equal(cardImageSrc(nullDisplay), LEGACY_LOCAL);
});

test("F. Korbel regression — Wine Cellar list exposes local enrichment for cards", async () => {
  cleanup();
  const wine = insertWine({
    name: "Korbel Sweet Cuvee California Champagne",
    producer: "Korbel",
    upc: KORBEL_UPC,
    image_url: ""
  });
  seedAccepted("wines", Number(wine.id), KORBEL_LOCAL);

  assert.equal(
    resolveInventoryDisplayImageUrl("wines", Number(wine.id), wine),
    KORBEL_LOCAL
  );
  const attached = attachInventoryDisplayImageUrl("wines", wine);
  assert.equal(attached.display_image_url, KORBEL_LOCAL);
  assert.equal(attached.image_url, "");

  const res = await app.inject({ method: "GET", url: "/api/inventory/wines" });
  const item = (res.json() as Array<Record<string, unknown>>).find(
    (r) => String(r.upc) === KORBEL_UPC
  );
  assert.ok(item);
  assert.equal(cardImageSrc(item!), KORBEL_LOCAL);
  cleanup();
});

test("G. Captain Morgan regression — Spirits list exposes local enrichment for cards", async () => {
  cleanup();
  const spirit = insertSpirit({
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    upc: CAPTAIN_UPC,
    image_url: ""
  });
  seedAccepted("spirits", Number(spirit.id), CAPTAIN_LOCAL);

  const res = await app.inject({ method: "GET", url: "/api/inventory/spirits" });
  const item = (res.json() as Array<Record<string, unknown>>).find(
    (r) => String(r.upc) === CAPTAIN_UPC
  );
  assert.ok(item);
  assert.equal(item!.image_url, "");
  assert.equal(item!.display_image_url, CAPTAIN_LOCAL);
  assert.equal(cardImageSrc(item!), CAPTAIN_LOCAL);
  cleanup();
});
