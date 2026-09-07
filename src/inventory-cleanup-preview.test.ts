import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { previewInventoryCleanup } from "./inventory-cleanup-preview.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken } = await import("./server.js");

const INVALID_BEER_UPC = "00899247";
const UNREFERENCED_UPC = "115001";
const REFERENCED_UPC = "036602301979";
const REFERENCED_EAN = `0${REFERENCED_UPC}`;
const ORPHAN_TYPE = "pr115_missing_inventory";

function count(sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

function cleanup(): void {
  db.prepare("DELETE FROM enrichment_jobs WHERE entity_type = ?").run(ORPHAN_TYPE);
  db.prepare("DELETE FROM packaged_beer WHERE name = 'PR115 Invalid Beer'").run();
  db.prepare("DELETE FROM wines WHERE name = 'PR115 Alias Wine'").run();
  db.prepare("DELETE FROM barcode_cache WHERE upc IN (?, ?)").run(UNREFERENCED_UPC, REFERENCED_UPC);
}

test("cleanup preview is bounded, read-only, and distinguishes referenced aliases", () => {
  cleanup();
  const baseline = previewInventoryCleanup();
  const beerId = Number(db.prepare(`
    INSERT INTO packaged_beer (brewery, name, style, abv, upc)
    VALUES ('Yuengling', 'PR115 Invalid Beer', 'Lager', 4.5, ?)
  `).run(INVALID_BEER_UPC).lastInsertRowid);
  db.prepare(`
    INSERT INTO wines (producer, name, type, upc)
    VALUES ('PR115', 'PR115 Alias Wine', 'Red', ?)
  `).run(REFERENCED_EAN);
  db.prepare(`
    INSERT INTO enrichment_jobs (entity_type, entity_id, upc, job_type, status)
    VALUES (?, 99115, '', 'metadata', 'failed')
  `).run(ORPHAN_TYPE);
  db.prepare(`INSERT INTO barcode_cache (upc, name, brand, category) VALUES (?, 'PR115 Loose', 'PR115', 'Test')`).run(UNREFERENCED_UPC);
  db.prepare(`INSERT INTO barcode_cache (upc, name, brand, category) VALUES (?, 'PR115 Alias', 'PR115', 'Test')`).run(REFERENCED_UPC);

  const before = {
    beer: count("SELECT COUNT(*) AS count FROM packaged_beer WHERE id = ?", beerId),
    orphan: count("SELECT COUNT(*) AS count FROM enrichment_jobs WHERE entity_type = ?", ORPHAN_TYPE),
    cache: count("SELECT COUNT(*) AS count FROM barcode_cache WHERE upc IN (?, ?)", UNREFERENCED_UPC, REFERENCED_UPC)
  };
  const preview = previewInventoryCleanup();
  const after = {
    beer: count("SELECT COUNT(*) AS count FROM packaged_beer WHERE id = ?", beerId),
    orphan: count("SELECT COUNT(*) AS count FROM enrichment_jobs WHERE entity_type = ?", ORPHAN_TYPE),
    cache: count("SELECT COUNT(*) AS count FROM barcode_cache WHERE upc IN (?, ?)", UNREFERENCED_UPC, REFERENCED_UPC)
  };

  assert.deepEqual(after, before);
  assert.equal(preview.readOnly, true);
  assert.ok(preview.invalidPackagedBeerBarcodes.items.length <= 50);
  assert.ok(preview.beerLikeSpiritRows.items.length <= 50);
  assert.ok(preview.orphanedArtifacts.items.length <= 50);
  assert.ok(preview.unreferencedLookupCache.sampleUpcs.length <= 50);
  assert.equal(preview.invalidPackagedBeerBarcodes.count, baseline.invalidPackagedBeerBarcodes.count + 1);
  assert.ok(preview.invalidPackagedBeerBarcodes.items.some((item) => item.entityId === beerId));
  assert.equal(preview.orphanedArtifacts.byTable.enrichment_jobs, baseline.orphanedArtifacts.byTable.enrichment_jobs + 1);
  assert.equal(preview.unreferencedLookupCache.byTable.barcode_cache, baseline.unreferencedLookupCache.byTable.barcode_cache + 1);
  cleanup();
});

test("cleanup preview endpoint requires Keeper authentication", async () => {
  const guest = await app.inject({ method: "GET", url: "/api/admin/inventory/cleanup-preview" });
  assert.equal(guest.statusCode, 401);

  const keeper = await app.inject({
    method: "GET",
    url: "/api/admin/inventory/cleanup-preview",
    headers: { authorization: `Bearer ${createTestAdminToken()}` }
  });
  assert.equal(keeper.statusCode, 200, keeper.body);
  assert.equal(keeper.json().readOnly, true);
});
