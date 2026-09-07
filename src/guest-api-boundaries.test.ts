/**
 * PR122 — Guest API data boundaries.
 * Guest inventory / enrichment HTTP responses must not leak Keeper-only fields.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db } from "./db.js";
import {
  GUEST_FORBIDDEN_ENRICHMENT_KEYS,
  GUEST_FORBIDDEN_INVENTORY_KEYS,
  serializeGuestEnrichmentView,
  serializeGuestInventoryItem
} from "./guest-inventory-response.js";
import {
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  upsertProductContent
} from "./ingestion/jobs/index.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken } = await import("./server.js");

const PREFIX = "09012200";

function cleanup() {
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%' OR name LIKE 'GuestBound%'`).run();
  db.prepare(`DELETE FROM wines WHERE upc LIKE '${PREFIX}%' OR name LIKE 'GuestBound%'`).run();
  db.prepare(`DELETE FROM packaged_beer WHERE upc LIKE '${PREFIX}%' OR name LIKE 'GuestBound%'`).run();
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
}

function insertSpirit() {
  const result = db.prepare(`
    INSERT INTO spirits (
      name, brand, category, sub_category, abv, volume_ml, fill_level, shelf_location,
      upc, notes, image_url, stock_count, tasting_notes, flavors, tags, blocked_from_ordering
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "GuestBound Spirit",
    "Bound Brand",
    "Whiskey",
    "Bourbon",
    45,
    750,
    50,
    "Top shelf B3",
    `${PREFIX}1001`,
    "Cellar note for patrons",
    "/api/media/images/guest-bound-spirit.jpg",
    3,
    "Oak and vanilla",
    '["oak"]',
    '["bourbon"]',
    0
  );
  return Number(result.lastInsertRowid);
}

function insertWine() {
  const result = db.prepare(`
    INSERT INTO wines (
      producer, name, varietal, vintage, type, style, region, sweetness, body,
      bottle_count, drink_by_date, pairings, notes, upc, image_url, tasting_notes, flavors, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "Bound Cellars",
    "GuestBound Wine",
    "Pinot Noir",
    2019,
    "Red",
    "Still",
    "Oregon",
    "Dry",
    3,
    4,
    "2030-01-01",
    "Duck",
    "Wine cellar note",
    `${PREFIX}2001`,
    "/api/media/images/guest-bound-wine.jpg",
    "Cherry and earth",
    '["cherry"]',
    '["pinot"]'
  );
  return Number(result.lastInsertRowid);
}

function insertBeer() {
  const result = db.prepare(`
    INSERT INTO packaged_beer (
      brewery, name, style, count, pack_date, abv, upc, image_url, notes, tasting_notes, vessel
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "Bound Brewing",
    "GuestBound Beer",
    "IPA",
    12,
    "2026-01-01",
    6.5,
    `${PREFIX}3001`,
    "/api/media/images/guest-bound-beer.jpg",
    "Cold room note",
    "Citrus hop",
    "Can"
  );
  return Number(result.lastInsertRowid);
}

function assertNoForbiddenKeys(payload: unknown, forbidden: readonly string[]) {
  const blob = JSON.stringify(payload);
  for (const key of forbidden) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload as object, key),
      false,
      `forbidden top-level key leaked: ${key}`
    );
    // Also catch nested dumps like inventory.upc or identity.upc.value
    assert.equal(
      new RegExp(`"${key}"\\s*:`).test(blob),
      false,
      `forbidden key leaked in JSON: ${key}`
    );
  }
}

before(() => {
  cleanup();
});

after(async () => {
  cleanup();
  await app.close();
});

test("serializer unit: guest inventory strips keeper fields and sets out_of_stock", () => {
  const spirit = serializeGuestInventoryItem("spirits", {
    id: 1,
    name: "Unit Spirit",
    brand: "Unit",
    category: "Rum",
    abv: 40,
    upc: "123",
    stock_count: 2,
    fill_level: 0,
    shelf_location: "A1",
    notes: "hi",
    vote_up: 1,
    vote_down: 0,
    vote_net: 1,
    vote_total: 1,
    vote_score: 1
  });
  assert.equal(spirit.name, "Unit Spirit");
  assert.equal(spirit.out_of_stock, false); // spare bottle remaining
  assert.equal(spirit.upc, undefined);
  assert.equal(spirit.stock_count, undefined);
  assert.equal(spirit.fill_level, undefined);
  assert.equal(spirit.shelf_location, undefined);
  assert.equal(spirit.vote_up, 1);

  const empty = serializeGuestInventoryItem("spirits", {
    id: 2,
    name: "Empty",
    brand: "X",
    category: "Gin",
    fill_level: 0,
    stock_count: 1
  });
  assert.equal(empty.out_of_stock, true);

  const beer = serializeGuestInventoryItem("packaged_beer", {
    id: 3,
    name: "Beer",
    brewery: "Y",
    style: "Lager",
    count: 0,
    upc: "999",
    vessel: "Can"
  });
  assert.equal(beer.out_of_stock, true);
  assert.equal(beer.count, undefined);
  assert.equal(beer.upc, undefined);
});

test("serializer unit: guest enrichment keeps tasting/image only", () => {
  const guest = serializeGuestEnrichmentView({
    entityType: "spirits",
    entityId: 9,
    inventory: { upc: "leak", stock_count: 9, shelf_location: "leak" },
    identity: {
      name: { value: "N", source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      brand: { value: "B", source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      productType: { value: "spirit", source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      upc: { value: "083664871681", source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "trusted" }
    },
    metadata: {
      category: { value: null, source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      abv: { value: null, source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      proof: { value: null, source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      volumeMl: { value: null, source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      origin: { value: null, source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" },
      ttbId: { value: null, source: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" }
    },
    enrichment: {
      identified: true,
      needsReview: true,
      missing: ["UPC"],
      jobs: [{ type: "metadata", status: "failed", statusLabel: "failed", attempts: 3, lastError: "boom", diagnostics: { jobType: "metadata", stages: [] } }],
      conflicts: [{ field: "name", keptValue: "a", keptSource: "vault", keptSourceLabel: "Vault", competingValue: "b", competingSource: "cola", competingSourceLabel: "COLA" }]
    },
    tastingNotes: {
      official: "Producer notes",
      sourceUrl: "https://example.com/secret",
      sourceType: "official",
      houseProfile: "House peat",
      personal: "private cellar"
    },
    image: {
      displayUrl: "/api/media/images/x.jpg",
      enrichedUrl: "/api/media/images/y.jpg",
      sourceType: "official",
      sourceUrl: "https://example.com/img",
      score: 0.9,
      verified: true,
      userPreferred: false
    }
  } as never);

  assert.equal((guest.tastingNotes as { official: string }).official, "Producer notes");
  assert.equal((guest.tastingNotes as { houseProfile: string }).houseProfile, "House peat");
  assert.equal((guest.image as { displayUrl: string }).displayUrl, "/api/media/images/x.jpg");
  assert.equal((guest.image as { userPreferred: boolean }).userPreferred, false);
  assertNoForbiddenKeys(guest, GUEST_FORBIDDEN_ENRICHMENT_KEYS);
  const blob = JSON.stringify(guest);
  assert.equal(blob.includes("083664871681"), false);
  assert.equal(blob.includes("https://example.com/secret"), false);
  assert.equal(blob.includes("private cellar"), false);
});

test("1. Guest spirits inventory returns public fields and omits keeper-only keys", async () => {
  cleanup();
  const id = insertSpirit();
  const res = await app.inject({ method: "GET", url: "/api/inventory/spirits" });
  assert.equal(res.statusCode, 200);
  const rows = res.json() as Array<Record<string, unknown>>;
  const item = rows.find((row) => row.id === id);
  assert.ok(item);
  assert.equal(item.name, "GuestBound Spirit");
  assert.equal(item.brand, "Bound Brand");
  assert.equal(item.category, "Whiskey");
  assert.equal(item.abv, 45);
  assert.equal(item.tasting_notes, "Oak and vanilla");
  assert.equal(item.image_url, "/api/media/images/guest-bound-spirit.jpg");
  assert.equal(item.out_of_stock, false);
  assert.equal(typeof item.vote_up, "number");
  assertNoForbiddenKeys(item, GUEST_FORBIDDEN_INVENTORY_KEYS);
  cleanup();
});

test("2. Guest wines and packaged beer retain entity-specific public fields without counts/UPC", async () => {
  cleanup();
  const wineId = insertWine();
  const beerId = insertBeer();

  const wines = await app.inject({ method: "GET", url: "/api/inventory/wines" });
  assert.equal(wines.statusCode, 200);
  const wine = (wines.json() as Array<Record<string, unknown>>).find((row) => row.id === wineId);
  assert.ok(wine);
  assert.equal(wine.producer, "Bound Cellars");
  assert.equal(wine.varietal, "Pinot Noir");
  assert.equal(wine.region, "Oregon");
  assert.equal(wine.sweetness, "Dry");
  assertNoForbiddenKeys(wine, GUEST_FORBIDDEN_INVENTORY_KEYS);

  const beers = await app.inject({ method: "GET", url: "/api/inventory/packaged_beer" });
  assert.equal(beers.statusCode, 200);
  const beer = (beers.json() as Array<Record<string, unknown>>).find((row) => row.id === beerId);
  assert.ok(beer);
  assert.equal(beer.brewery, "Bound Brewing");
  assert.equal(beer.style, "IPA");
  assert.equal(beer.vessel, "Can");
  assert.equal(beer.out_of_stock, false);
  assert.equal(beer.abv, 6.5);
  // Packaged beer must not invent proof / volume_ml semantics for guests either.
  assert.equal(Object.prototype.hasOwnProperty.call(beer, "proof"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(beer, "volume_ml"), false);
  assertNoForbiddenKeys(beer, GUEST_FORBIDDEN_INVENTORY_KEYS);
  cleanup();
});

test("3. Keeper-authenticated inventory still returns full shelf representation", async () => {
  cleanup();
  const spiritId = insertSpirit();
  const wineId = insertWine();
  const beerId = insertBeer();
  const token = createTestAdminToken();

  const spirits = await app.inject({
    method: "GET",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(spirits.statusCode, 200);
  const spirit = (spirits.json() as Array<Record<string, unknown>>).find((row) => row.id === spiritId);
  assert.ok(spirit);
  assert.equal(spirit.upc, `${PREFIX}1001`);
  assert.equal(spirit.stock_count, 3);
  assert.equal(spirit.fill_level, 50);
  assert.equal(spirit.shelf_location, "Top shelf B3");

  const wines = await app.inject({
    method: "GET",
    url: "/api/inventory/wines",
    headers: { authorization: `Bearer ${token}` }
  });
  const wine = (wines.json() as Array<Record<string, unknown>>).find((row) => row.id === wineId);
  assert.ok(wine);
  assert.equal(wine.upc, `${PREFIX}2001`);
  assert.equal(wine.bottle_count, 4);

  const beers = await app.inject({
    method: "GET",
    url: "/api/inventory/packaged_beer",
    headers: { authorization: `Bearer ${token}` }
  });
  const beer = (beers.json() as Array<Record<string, unknown>>).find((row) => row.id === beerId);
  assert.ok(beer);
  assert.equal(beer.upc, `${PREFIX}3001`);
  assert.equal(beer.count, 12);
  cleanup();
});

test("4-5. Guest enrichment is redacted; Keeper enrichment remains intact", async () => {
  cleanup();
  const id = insertSpirit();
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Producer tasting notes for patrons.",
    officialSourceUrl: "https://example.com/notes",
    officialSourceType: "official",
    houseProfile: "House peat profile."
  });

  const guest = await app.inject({
    method: "GET",
    url: `/api/inventory/spirits/${id}/enrichment`
  });
  assert.equal(guest.statusCode, 200);
  const guestBody = guest.json() as {
    tastingNotes: { official: string | null; houseProfile: string | null; sourceUrl?: string };
    image: { displayUrl: string | null; userPreferred: boolean };
  };
  assert.ok(String(guestBody.tastingNotes.official ?? "").includes("Producer tasting"));
  assert.ok(String(guestBody.tastingNotes.houseProfile ?? "").includes("House peat"));
  assert.equal(guestBody.tastingNotes.sourceUrl, undefined);
  assertNoForbiddenKeys(guestBody, GUEST_FORBIDDEN_ENRICHMENT_KEYS);
  assert.equal(JSON.stringify(guestBody).includes(`${PREFIX}1001`), false);
  assert.equal(JSON.stringify(guestBody).includes("Top shelf B3"), false);

  const token = createTestAdminToken();
  const keeper = await app.inject({
    method: "GET",
    url: `/api/inventory/spirits/${id}/enrichment`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(keeper.statusCode, 200);
  const keeperBody = keeper.json() as {
    inventory: Record<string, unknown>;
    identity: { upc: { value: string | null } };
    enrichment: { jobs: unknown[]; conflicts: unknown[] };
    tastingNotes: { official: string | null; sourceUrl: string | null; houseProfile: string | null };
  };
  assert.equal(keeperBody.inventory.upc, `${PREFIX}1001`);
  assert.equal(keeperBody.inventory.stock_count, 3);
  assert.equal(keeperBody.inventory.shelf_location, "Top shelf B3");
  assert.equal(keeperBody.identity.upc.value, `${PREFIX}1001`);
  assert.ok(Array.isArray(keeperBody.enrichment.jobs));
  assert.ok(Array.isArray(keeperBody.enrichment.conflicts));
  assert.equal(keeperBody.tastingNotes.sourceUrl, "https://example.com/notes");
  assert.ok(String(keeperBody.tastingNotes.official ?? "").includes("Producer tasting"));
  cleanup();
});

test("6. Guest out_of_stock derives without leaking exact counts", async () => {
  cleanup();
  const emptySpirit = db.prepare(`
    INSERT INTO spirits (name, brand, category, fill_level, stock_count, upc)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("GuestBound Empty", "Bound", "Gin", 0, 1, `${PREFIX}1002`);
  const emptyBeer = db.prepare(`
    INSERT INTO packaged_beer (brewery, name, style, count, upc, vessel)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("Bound", "GuestBound Empty Beer", "Lager", 0, `${PREFIX}3002`, "Can");

  const spirits = await app.inject({ method: "GET", url: "/api/inventory/spirits" });
  const spirit = (spirits.json() as Array<Record<string, unknown>>)
    .find((row) => row.id === Number(emptySpirit.lastInsertRowid));
  assert.ok(spirit);
  assert.equal(spirit.out_of_stock, true);
  assert.equal(spirit.stock_count, undefined);
  assert.equal(spirit.fill_level, undefined);

  const beers = await app.inject({ method: "GET", url: "/api/inventory/packaged_beer" });
  const beer = (beers.json() as Array<Record<string, unknown>>)
    .find((row) => row.id === Number(emptyBeer.lastInsertRowid));
  assert.ok(beer);
  assert.equal(beer.out_of_stock, true);
  assert.equal(beer.count, undefined);
  cleanup();
});

test("7. Guest client prefers out_of_stock for card availability styling", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../client/src/App.tsx"), "utf8");
  assert.match(appSrc, /typeof item\.out_of_stock === "boolean"/);
  assert.match(appSrc, /item\.out_of_stock/);
});
