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
  db.prepare(`DELETE FROM brews WHERE batch_name LIKE 'GuestBound%' OR brewfather_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM cocktails WHERE name LIKE 'GuestBound%'`).run();
  // Reset any tap we may have filled for GuestBound coverage.
  db.prepare(`
    UPDATE taps SET
      brewery_batch='', maker='', style='', abv=0, ibu=0, tapped_date=NULL,
      remaining_l=0, notes='', tasting_notes='', image_url='', flavors='[]', tags='[]'
    WHERE brewery_batch LIKE 'GuestBound%' OR notes LIKE 'GuestBound%'
  `).run();
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
}

function insertSpirit() {
  const result = db.prepare(`
    INSERT INTO spirits (
      name, brand, category, sub_category, abv, volume_ml, fill_level, purchase_date, opened_date,
      shelf_location, upc, notes, image_url, stock_count, tasting_notes, flavors, tags, blocked_from_ordering
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "GuestBound Spirit",
    "Bound Brand",
    "Whiskey",
    "Bourbon",
    45,
    750,
    50,
    "2025-01-15",
    "2025-06-01",
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
  const spareReady = serializeGuestInventoryItem("spirits", {
    id: 1,
    name: "Unit Spirit",
    brand: "Unit",
    category: "Rum",
    abv: 40,
    upc: "123",
    stock_count: 2,
    fill_level: 0,
    shelf_location: "A1",
    purchase_date: "2024-01-01",
    opened_date: "2024-02-01",
    notes: "hi",
    vote_up: 1,
    vote_down: 0,
    vote_net: 1,
    vote_total: 1,
    vote_score: 1
  });
  assert.equal(spareReady.name, "Unit Spirit");
  assert.equal(spareReady.out_of_stock, false); // spare bottle remaining
  // Empty open bottle + spare → guest sees a full available bottle, not 0%/last pours.
  assert.equal(spareReady.availability_pct, 100);
  assert.equal(spareReady.upc, undefined);
  assert.equal(spareReady.stock_count, undefined);
  assert.equal(spareReady.fill_level, undefined);
  assert.equal(spareReady.shelf_location, undefined);
  assert.equal(spareReady.purchase_date, undefined);
  assert.equal(spareReady.opened_date, undefined);
  assert.equal(spareReady.vote_up, 1);

  const empty = serializeGuestInventoryItem("spirits", {
    id: 2,
    name: "Empty",
    brand: "X",
    category: "Gin",
    fill_level: 0,
    stock_count: 1
  });
  assert.equal(empty.out_of_stock, true);
  assert.equal(empty.availability_pct, 0);
  assert.equal(empty.fill_level, undefined);
  assert.equal(empty.stock_count, undefined);

  const half = serializeGuestInventoryItem("spirits", {
    id: 4,
    name: "Half",
    brand: "X",
    category: "Whiskey",
    fill_level: 50,
    stock_count: 1,
    upc: "leak"
  });
  assert.equal(half.out_of_stock, false);
  assert.equal(half.availability_pct, 50);
  assert.equal(half.fill_level, undefined);
  assert.equal(half.stock_count, undefined);
  assert.equal(half.upc, undefined);

  // Partial open bottle with spares still reports the open bottle's coarse fill.
  const halfWithSpare = serializeGuestInventoryItem("spirits", {
    id: 6,
    name: "Half Spare",
    brand: "X",
    category: "Whiskey",
    fill_level: 50,
    stock_count: 3
  });
  assert.equal(halfWithSpare.out_of_stock, false);
  assert.equal(halfWithSpare.availability_pct, 50);
  assert.equal(halfWithSpare.fill_level, undefined);
  assert.equal(halfWithSpare.stock_count, undefined);

  const tap = serializeGuestInventoryItem("taps", {
    id: 5,
    tap_number: 1,
    brewery_batch: "House Ale",
    style: "Pale",
    abv: 5,
    remaining_l: 9.5,
    keg_size_l: 19.5
  });
  assert.equal(tap.availability_pct, 50);
  assert.equal(tap.remaining_l, undefined);
  assert.equal(tap.keg_size_l, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(tap, "pints"), false);

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
  assert.equal(beer.availability_pct, undefined);
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
  assert.equal(item.availability_pct, 50);
  assert.equal(typeof item.vote_up, "number");
  assert.equal(item.purchase_date, undefined);
  assert.equal(item.opened_date, undefined);
  assert.equal(item.fill_level, undefined);
  assert.equal(item.stock_count, undefined);
  assert.equal(item.upc, undefined);
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
  assert.equal(spirit.purchase_date, "2025-01-15");
  assert.equal(spirit.opened_date, "2025-06-01");

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
  const spareSpirit = db.prepare(`
    INSERT INTO spirits (name, brand, category, fill_level, stock_count, upc)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("GuestBound Spare", "Bound", "Rum", 0, 2, `${PREFIX}1003`);
  const emptyBeer = db.prepare(`
    INSERT INTO packaged_beer (brewery, name, style, count, upc, vessel)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("Bound", "GuestBound Empty Beer", "Lager", 0, `${PREFIX}3002`, "Can");

  const spirits = await app.inject({ method: "GET", url: "/api/inventory/spirits" });
  const spirit = (spirits.json() as Array<Record<string, unknown>>)
    .find((row) => row.id === Number(emptySpirit.lastInsertRowid));
  assert.ok(spirit);
  assert.equal(spirit.out_of_stock, true);
  assert.equal(spirit.availability_pct, 0);
  assert.equal(spirit.stock_count, undefined);
  assert.equal(spirit.fill_level, undefined);

  const spare = (spirits.json() as Array<Record<string, unknown>>)
    .find((row) => row.id === Number(spareSpirit.lastInsertRowid));
  assert.ok(spare);
  assert.equal(spare.out_of_stock, false);
  assert.equal(spare.availability_pct, 100);
  assert.equal(spare.stock_count, undefined);
  assert.equal(spare.fill_level, undefined);

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

test("8. Guest allowlist covers taps, brews, and cocktails without keeper internals", async () => {
  cleanup();
  const token = createTestAdminToken();

  const tap = db.prepare("SELECT id, tap_number FROM taps ORDER BY tap_number ASC LIMIT 1").get() as {
    id: number;
    tap_number: number;
  };
  assert.ok(tap?.id);
  db.prepare(`
    UPDATE taps SET
      brewery_batch=?, maker=?, style=?, abv=?, ibu=?, tapped_date=?,
      remaining_l=?, keg_size_l=?, notes=?, tasting_notes=?, image_url=?
    WHERE id=?
  `).run(
    "GuestBound Tap Ale",
    "Bound Taproom",
    "Pale Ale",
    5.2,
    35,
    "2026-03-01",
    9.5,
    19.5,
    "GuestBound tap note",
    "Citrus and pine",
    "/api/media/images/guest-bound-tap.jpg",
    tap.id
  );

  const brewId = Number(db.prepare(`
    INSERT INTO brews (
      batch_name, style, brew_date, target_og, target_fg, measured_og, measured_fg,
      calculated_abv, schedule, status, notes, maker, image_url, tasting_notes, hops, brewfather_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "GuestBound House Pale",
    "APA",
    "2026-02-01",
    1.05,
    1.01,
    1.049,
    1.011,
    5.1,
    "mash schedule",
    "Fermenting",
    "GuestBound brew note",
    "Bound Brewery",
    "/api/media/images/guest-bound-brew.jpg",
    "Biscuit malt",
    '["Cascade"]',
    `${PREFIX}brew1`
  ).lastInsertRowid);

  const cocktailId = Number(db.prepare(`
    INSERT INTO cocktails (name, collection, ingredients, glassware, garnish, method, notes, season)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "GuestBound Negroni",
    "GuestBound Classics",
    "Gin, Campari, Sweet vermouth",
    "Rocks",
    "Orange peel",
    "Stir",
    "GuestBound cocktail note",
    "All"
  ).lastInsertRowid);

  const cases: Array<{
    table: string;
    id: number;
    expectedGuest: Record<string, unknown>;
    guestOnly?: Record<string, unknown>;
    keeperOnly: Record<string, unknown>;
  }> = [
    {
      table: "taps",
      id: tap.id,
      expectedGuest: {
        brewery_batch: "GuestBound Tap Ale",
        maker: "Bound Taproom",
        style: "Pale Ale",
        abv: 5.2,
        ibu: 35,
        tasting_notes: "Citrus and pine"
      },
      guestOnly: { availability_pct: 50 },
      keeperOnly: { remaining_l: 9.5, keg_size_l: 19.5 }
    },
    {
      table: "brews",
      id: brewId,
      expectedGuest: {
        batch_name: "GuestBound House Pale",
        style: "APA",
        status: "Fermenting",
        calculated_abv: 5.1,
        maker: "Bound Brewery"
      },
      keeperOnly: {
        brewfather_id: `${PREFIX}brew1`,
        target_og: 1.05,
        measured_og: 1.049,
        measured_fg: 1.011
      }
    },
    {
      table: "cocktails",
      id: cocktailId,
      expectedGuest: {
        name: "GuestBound Negroni",
        collection: "GuestBound Classics",
        glassware: "Rocks",
        method: "Stir",
        season: "All"
      },
      keeperOnly: {}
    }
  ];

  for (const entry of cases) {
    const guestRes = await app.inject({ method: "GET", url: `/api/inventory/${entry.table}` });
    assert.equal(guestRes.statusCode, 200, entry.table);
    const guestRows = guestRes.json() as Array<Record<string, unknown>>;
    assert.ok(guestRows.length > 0, `${entry.table} guest list must not be empty`);
    const guestItem = guestRows.find((row) => Number(row.id) === entry.id);
    assert.ok(guestItem, `${entry.table} guest row missing`);
    for (const [key, value] of Object.entries(entry.expectedGuest)) {
      assert.equal(guestItem[key], value, `${entry.table}.${key}`);
    }
    for (const [key, value] of Object.entries(entry.guestOnly ?? {})) {
      assert.equal(guestItem[key], value, `${entry.table}.guestOnly.${key}`);
    }
    assertNoForbiddenKeys(guestItem, GUEST_FORBIDDEN_INVENTORY_KEYS);
    for (const key of Object.keys(entry.keeperOnly)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(guestItem, key),
        false,
        `${entry.table} guest leaked ${key}`
      );
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(guestItem, "pints"),
      false,
      `${entry.table} guest must not expose exact pints`
    );

    const keeperRes = await app.inject({
      method: "GET",
      url: `/api/inventory/${entry.table}`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(keeperRes.statusCode, 200, entry.table);
    const keeperItem = (keeperRes.json() as Array<Record<string, unknown>>)
      .find((row) => Number(row.id) === entry.id);
    assert.ok(keeperItem, `${entry.table} keeper row missing`);
    for (const [key, value] of Object.entries(entry.expectedGuest)) {
      assert.equal(keeperItem[key], value, `keeper ${entry.table}.${key}`);
    }
    for (const [key, value] of Object.entries(entry.keeperOnly)) {
      assert.equal(keeperItem[key], value, `keeper ${entry.table}.${key}`);
    }
    for (const key of Object.keys(entry.guestOnly ?? {})) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(keeperItem, key),
        false,
        `keeper ${entry.table} should not carry guest-only derived ${key}`
      );
    }
  }

  cleanup();
});

test("9. Guest overview keeps keg gauge and strips exact pints", async () => {
  cleanup();
  const tap = db.prepare("SELECT id FROM taps ORDER BY tap_number ASC LIMIT 1").get() as { id: number };
  assert.ok(tap?.id);
  db.prepare(`
    UPDATE taps SET
      brewery_batch=?, maker=?, style=?, abv=?, remaining_l=?, keg_size_l=?, notes=?
    WHERE id=?
  `).run("GuestBound Overview Ale", "Bound", "Lager", 5, 19.5, 19.5, "GuestBound overview", tap.id);

  const guest = await app.inject({ method: "GET", url: "/api/overview" });
  assert.equal(guest.statusCode, 200);
  const guestSnap = guest.json() as {
    taps: { list: Array<{ title: string; remaining_pct?: number; pints?: number }> };
  };
  const guestTap = guestSnap.taps.list.find((row) => row.title === "GuestBound Overview Ale");
  assert.ok(guestTap);
  assert.equal(guestTap.remaining_pct, 100);
  assert.equal(Object.prototype.hasOwnProperty.call(guestTap, "pints"), false);

  const token = createTestAdminToken();
  const keeper = await app.inject({
    method: "GET",
    url: "/api/overview",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(keeper.statusCode, 200);
  const keeperSnap = keeper.json() as {
    taps: { list: Array<{ title: string; remaining_pct?: number; pints?: number }> };
  };
  const keeperTap = keeperSnap.taps.list.find((row) => row.title === "GuestBound Overview Ale");
  assert.ok(keeperTap);
  assert.equal(keeperTap.remaining_pct, 100);
  assert.equal(keeperTap.pints, 41);
  cleanup();
});

test("10. Guest client renders gauges from availability_pct, not raw Keeper quantities", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
  const helperSrc = readFileSync(join(root, "client/src/guestAvailability.ts"), "utf8");
  assert.match(appSrc, /spiritGaugePct\(item, admin\)/);
  assert.match(appSrc, /tapGaugeForDisplay\(item, admin, DEFAULT_KEG_L\)/);
  assert.match(appSrc, /readAvailabilityPct\(item\)/);
  assert.match(appSrc, /guestTapAvailabilityLabel/);
  assert.match(appSrc, /guestSpiritAvailabilityLabel/);
  // Guest availability lines must not interpolate exact pint counts.
  assert.doesNotMatch(
    appSrc,
    /availability-line[\s\S]{0,240}kegPints/
  );
  assert.doesNotMatch(
    appSrc,
    /availability-line[\s\S]{0,240}pints left/
  );
  assert.match(helperSrc, /availability_pct/);
  assert.match(helperSrc, /never exact pint counts/);
});
