import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const { saveBarcodeCacheEntry } = await import("./barcode_cache.js");
const { isSpiritEmpty, isZeroStockShelfItem } = await import("./catalog.js");
const { spiritOnShelf } = await import("./cocktails.js");
const { listTonightPours } = await import("./pours.js");
const { saveScanSessionBottle, undoScanSessionMutation } = await import("./scan-session.js");
const { spiritFlavorFacetOptions, resolveSpiritDisplayFlavors } = await import("./spirit-flavors.js");
const { shelfItemMatchesAvailability, spiritIsAvailable } = await import("../client/src/spirit-search.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const recountCardSrc = readFileSync(join(root, "client/src/InventoryRecountCard.tsx"), "utf8");

const SPIRIT_UPC = "089540123455";
const WINE_UPC = "085000012345";
const BEER_UPC = "071990300104";

function cleanup() {
  db.prepare("DELETE FROM reviews WHERE author = 'RecountTester'").run();
  db.prepare("DELETE FROM spirits WHERE upc = ?").run(SPIRIT_UPC);
  db.prepare("DELETE FROM wines WHERE upc = ?").run(WINE_UPC);
  db.prepare("DELETE FROM packaged_beer WHERE upc = ?").run(BEER_UPC);
  db.prepare("DELETE FROM barcode_cache WHERE upc IN (?, ?, ?)").run(SPIRIT_UPC, WINE_UPC, BEER_UPC);
}

test("recount preview and zero-counts require Keeper authentication", async () => {
  const previewRes = await app.inject({
    method: "GET",
    url: "/api/admin/inventory/recount-preview"
  });
  assert.equal(previewRes.statusCode, 401);

  const zeroRes = await app.inject({
    method: "POST",
    url: "/api/admin/inventory/zero-counts",
    payload: { tables: ["spirits"], confirm: "ZERO" }
  });
  assert.equal(zeroRes.statusCode, 401);
});

test("zero-counts validates confirmation and rejects non-shelf tables", async () => {
  const token = createTestAdminToken();

  const missingConfirm = await app.inject({
    method: "POST",
    url: "/api/admin/inventory/zero-counts",
    headers: { authorization: `Bearer ${token}` },
    payload: { tables: ["spirits"] }
  });
  assert.equal(missingConfirm.statusCode, 400);

  const invalidTables = await app.inject({
    method: "POST",
    url: "/api/admin/inventory/zero-counts",
    headers: { authorization: `Bearer ${token}` },
    payload: { tables: ["taps", "brews"], confirm: "ZERO" }
  });
  assert.equal(invalidTables.statusCode, 400);
});

test("per-section zero-counts preserves all bottle metadata, reviews, caches, and taps while avoiding fake pours", async () => {
  cleanup();
  const token = createTestAdminToken();
  const poursBefore = listTonightPours().length;

  const spiritId = Number(
    db.prepare(`
      INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, fill_level, shelf_location, upc, notes, image_url, stock_count, tasting_notes, flavors, tags)
      VALUES ('Recount Bourbon', 'Vault Distilling', 'Whiskey', 'Bourbon', 47.5, 750, 75, 'Top Shelf A', ?, 'Barrel pick', '/api/media/images/bourbon.webp', 3, 'Caramel, vanilla, toasted oak', '["Vanilla","Oak"]', '["allocated"]')
    `).run(SPIRIT_UPC).lastInsertRowid
  );
  const wineId = Number(
    db.prepare(`
      INSERT INTO wines (producer, name, varietal, vintage, type, region, bottle_count, notes, upc, tasting_notes)
      VALUES ('Vault Cellars', 'Recount Cab', 'Cabernet Sauvignon', 2021, 'Red', 'Napa', 4, 'Cellar favorite', ?, 'Blackberry and cedar')
    `).run(WINE_UPC).lastInsertRowid
  );
  const beerId = Number(
    db.prepare(`
      INSERT INTO packaged_beer (brewery, name, style, count, abv, upc, vessel, tasting_notes)
      VALUES ('Vault Brewing', 'Recount Pils', 'Pilsner', 6, 5.1, ?, 'Can', 'Crisp cracker malt')
    `).run(BEER_UPC).lastInsertRowid
  );
  db.prepare("INSERT INTO reviews (table_name, item_id, author, body) VALUES ('spirits', ?, 'RecountTester', 'Keep this note')").run(spiritId);
  saveBarcodeCacheEntry({
    upc: SPIRIT_UPC,
    name: "Recount Bourbon",
    brand: "Vault Distilling",
    category: "Whiskey",
    abv: 47.5,
    volume_ml: 750,
    source: "imported"
  });

  const tapSnapshot = db.prepare("SELECT id, tap_number, brewery_batch, remaining_l FROM taps ORDER BY tap_number ASC").all();

  try {
    // 1. Preview reflects live stock rows.
    const previewRes = await app.inject({
      method: "GET",
      url: "/api/admin/inventory/recount-preview",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(previewRes.statusCode, 200);
    const preview = previewRes.json() as {
      sections: Record<"spirits" | "wines" | "packaged_beer", { totalRows: number; inStockRows: number; zeroStockRows: number }>;
    };
    assert.ok(preview.sections.spirits.inStockRows >= 1);
    assert.ok(preview.sections.wines.inStockRows >= 1);
    assert.ok(preview.sections.packaged_beer.inStockRows >= 1);

    // 2. Zeroing ONLY spirits leaves wines and packaged_beer untouched.
    const spiritsOnlyRes = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/zero-counts",
      headers: { authorization: `Bearer ${token}` },
      payload: { tables: ["spirits"], confirm: "ZERO" }
    });
    assert.equal(spiritsOnlyRes.statusCode, 200);

    const spiritAfterFirst = db.prepare("SELECT * FROM spirits WHERE id = ?").get(spiritId) as Record<string, unknown>;
    assert.equal(spiritAfterFirst.stock_count, 0);
    assert.equal(spiritAfterFirst.fill_level, 0);
    assert.equal(spiritAfterFirst.name, "Recount Bourbon");
    assert.equal(spiritAfterFirst.shelf_location, "Top Shelf A");
    assert.equal(spiritAfterFirst.image_url, "/api/media/images/bourbon.webp");
    assert.equal(spiritAfterFirst.tasting_notes, "Caramel, vanilla, toasted oak");
    assert.equal(spiritAfterFirst.flavors, '["Vanilla","Oak"]');
    assert.equal(spiritAfterFirst.tags, '["allocated"]');

    const wineUntouched = db.prepare("SELECT bottle_count FROM wines WHERE id = ?").get(wineId) as { bottle_count: number };
    const beerUntouched = db.prepare("SELECT count FROM packaged_beer WHERE id = ?").get(beerId) as { count: number };
    assert.equal(wineUntouched.bottle_count, 4);
    assert.equal(beerUntouched.count, 6);

    // 3. Zeroing remaining sections zeroes wines & packaged_beer; taps, reviews, cache, and pours remain untouched.
    const restRes = await app.inject({
      method: "POST",
      url: "/api/admin/inventory/zero-counts",
      headers: { authorization: `Bearer ${token}` },
      payload: { tables: ["wines", "packaged_beer"], confirm: "ZERO" }
    });
    assert.equal(restRes.statusCode, 200);

    const wineZeroed = db.prepare("SELECT bottle_count, notes, tasting_notes FROM wines WHERE id = ?").get(wineId) as Record<string, unknown>;
    const beerZeroed = db.prepare("SELECT count, style, tasting_notes FROM packaged_beer WHERE id = ?").get(beerId) as Record<string, unknown>;
    assert.equal(wineZeroed.bottle_count, 0);
    assert.equal(wineZeroed.notes, "Cellar favorite");
    assert.equal(beerZeroed.count, 0);
    assert.equal(beerZeroed.tasting_notes, "Crisp cracker malt");

    const reviewCount = (db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE table_name = 'spirits' AND item_id = ?").get(spiritId) as { n: number }).n;
    assert.equal(reviewCount, 1);
    const cacheRow = db.prepare("SELECT name FROM barcode_cache WHERE upc = ?").get(SPIRIT_UPC) as { name: string } | undefined;
    assert.equal(cacheRow?.name, "Recount Bourbon");
    assert.deepEqual(
      db.prepare("SELECT id, tap_number, brewery_batch, remaining_l FROM taps ORDER BY tap_number ASC").all(),
      tapSnapshot
    );
    assert.equal(listTonightPours().length, poursBefore, "zeroing counts must not log pours");

    // 4. Guest inventory shows Out of stock without leaking exact counts or UPCs; Restock excludes 0-stock items.
    for (const [table, id] of [["spirits", spiritId], ["wines", wineId], ["packaged_beer", beerId]] as const) {
      const guestList = await app.inject({ method: "GET", url: `/api/inventory/${table}` });
      assert.equal(guestList.statusCode, 200);
      const guestItem = (guestList.json() as Array<Record<string, unknown>>).find((row) => Number(row.id) === id);
      assert.ok(guestItem, `expected zeroed ${table} item in guest list`);
      assert.equal(guestItem!.out_of_stock, true);
      assert.equal(guestItem!.upc, undefined);
      assert.equal(guestItem!.stock_count, undefined);
      assert.equal(guestItem!.bottle_count, undefined);
      assert.equal(guestItem!.count, undefined);
      assert.equal(guestItem!.fill_level, undefined);
      if (table === "spirits") assert.equal(guestItem!.availability_pct, 0);
    }

    const restockRes = await app.inject({
      method: "GET",
      url: "/api/restock",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(restockRes.statusCode, 200);
    const restockItems = (restockRes.json() as { items: Array<{ key: string }> }).items;
    assert.equal(restockItems.some((item) => item.key === `spirits:${spiritId}`), false);
    assert.equal(restockItems.some((item) => item.key === `wines:${wineId}`), false);
    assert.equal(restockItems.some((item) => item.key === `packaged_beer:${beerId}`), false);

    // 5. Scanning zeroed bottles back in restores 0 → 1 (Full 100% for spirits) and Undo restores 0 / 0.
    const firstSpiritScan = await saveScanSessionBottle({ code: SPIRIT_UPC, kind: "spirits" });
    assert.equal(firstSpiritScan.action, "updated");
    assert.equal(firstSpiritScan.quantityBefore, 0);
    assert.equal(firstSpiritScan.quantityAfter, 1);

    const restoredSpirit = db.prepare("SELECT stock_count, fill_level, tasting_notes, shelf_location FROM spirits WHERE id = ?").get(spiritId) as {
      stock_count: number;
      fill_level: number;
      tasting_notes: string;
      shelf_location: string;
    };
    assert.equal(restoredSpirit.stock_count, 1);
    assert.equal(restoredSpirit.fill_level, 100, "0 -> 1 spirit scan defaults to Full (100%)");
    assert.equal(restoredSpirit.tasting_notes, "Caramel, vanilla, toasted oak");
    assert.equal(restoredSpirit.shelf_location, "Top Shelf A");
    assert.equal(isSpiritEmpty(restoredSpirit), false);
    assert.equal(spiritOnShelf(restoredSpirit), true);

    const secondSpiritScan = await saveScanSessionBottle({ code: SPIRIT_UPC, kind: "spirits" });
    assert.equal(secondSpiritScan.quantityBefore, 1);
    assert.equal(secondSpiritScan.quantityAfter, 2);

    // Undo second scan -> back to 1 full; undo first scan -> back to 0 stock / 0 fill.
    assert.equal(undoScanSessionMutation(secondSpiritScan.undo!).ok, true);
    assert.equal(undoScanSessionMutation(firstSpiritScan.undo!).ok, true);
    const undoneSpirit = db.prepare("SELECT stock_count, fill_level FROM spirits WHERE id = ?").get(spiritId) as {
      stock_count: number;
      fill_level: number;
    };
    assert.equal(undoneSpirit.stock_count, 0);
    assert.equal(undoneSpirit.fill_level, 0);

    const wineScan = await saveScanSessionBottle({ code: WINE_UPC, kind: "wines" });
    assert.equal(wineScan.action, "updated");
    assert.equal(wineScan.quantityBefore, 0);
    assert.equal(wineScan.quantityAfter, 1);

    const beerScan = await saveScanSessionBottle({ code: BEER_UPC, kind: "beer" });
    assert.equal(beerScan.action, "updated");
    assert.equal(beerScan.quantityBefore, 0);
    assert.equal(beerScan.quantityAfter, 1);
  } finally {
    cleanup();
  }
});

test("Keeper '0 in stock' filter distinguishes zeroed items from empty open bottles and stays Keeper-only", () => {
  const zeroedSpirit = { id: 1, category: "Whiskey", stock_count: 0, fill_level: 0, flavors: '["Vanilla"]' };
  const emptyOpenSpirit = { id: 2, category: "Whiskey", stock_count: 1, fill_level: 0, flavors: '["Smoke"]' };
  const fullSpirit = { id: 3, category: "Whiskey", stock_count: 1, fill_level: 100, flavors: '["Caramel"]' };

  assert.equal(isZeroStockShelfItem("spirits", zeroedSpirit), true);
  assert.equal(isZeroStockShelfItem("spirits", emptyOpenSpirit), false);
  assert.equal(isZeroStockShelfItem("spirits", fullSpirit), false);
  assert.equal(spiritIsAvailable(zeroedSpirit), false);
  assert.equal(spiritIsAvailable(emptyOpenSpirit), false);
  assert.equal(spiritIsAvailable(fullSpirit), true);

  const items = [zeroedSpirit, emptyOpenSpirit, fullSpirit];
  const flavorsById = new Map(items.map((item) => [item.id, resolveSpiritDisplayFlavors(item)]));
  const zeroFlavors = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Whiskey",
    availability: "zero",
    isAvailable: spiritIsAvailable,
    isZeroStock: (item) => isZeroStockShelfItem("spirits", item)
  });
  assert.deepEqual(zeroFlavors, ["Vanilla"]);

  assert.equal(shelfItemMatchesAvailability("wines", { bottle_count: 0 }, "zero", true), true);
  assert.equal(shelfItemMatchesAvailability("wines", { bottle_count: 2 }, "zero", true), false);
  assert.equal(shelfItemMatchesAvailability("wines", { bottle_count: 2 }, "zero", false), true, "Guest ignores Keeper-only zero filter");
  assert.equal(shelfItemMatchesAvailability("packaged_beer", { count: 0 }, "zero", true), true);
  assert.equal(shelfItemMatchesAvailability("packaged_beer", { count: 4 }, "zero", true), false);

  assert.match(appSrc, /\{admin && <option value="zero">0 in stock<\/option>\}/);
  assert.match(recountCardSrc, /\/admin\/inventory\/zero-counts/);
});
