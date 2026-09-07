import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { getLatestAdminAuditEvent } from "./ingestion/jobs/admin-audit.js";
import { verifiedInventoryUpcAliases } from "./inventory-delete.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken } = await import("./server.js");

const BEER_UPC = "089924788874";
const SPIRIT_UPC = "036602301979";
const TEST_NAMES = ["PR114 Delete Beer", "PR114 Shared Spirit", "PR114 Busy Spirit"];

function count(sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

function cleanup(): void {
  db.prepare(`DELETE FROM reviews WHERE table_name IN ('spirits','packaged_beer')`).run();
  db.prepare(`DELETE FROM votes WHERE table_name IN ('spirits','packaged_beer')`).run();
  db.prepare(`DELETE FROM daily_votes WHERE target_table IN ('spirits','packaged_beer')`).run();
  db.prepare("DELETE FROM restock_got WHERE key LIKE 'packaged_beer:%' OR key LIKE 'spirits:%'").run();
  for (const table of [
    "enrichment_jobs",
    "product_content",
    "product_images",
    "product_field_ownership",
    "enrichment_sources",
    "official_image_repair_requests"
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE entity_type IN ('spirits','packaged_beer')`).run();
  }
  db.prepare("DELETE FROM pours WHERE name LIKE 'PR114 %'").run();
  db.prepare(`DELETE FROM packaged_beer WHERE name IN (${TEST_NAMES.map(() => "?").join(",")})`).run(...TEST_NAMES);
  db.prepare(`DELETE FROM spirits WHERE name IN (${TEST_NAMES.map(() => "?").join(",")})`).run(...TEST_NAMES);
  for (const upc of [BEER_UPC, SPIRIT_UPC, `0${SPIRIT_UPC}`, "00899247", "000000899247"]) {
    db.prepare("DELETE FROM barcode_cache WHERE upc = ?").run(upc);
    db.prepare("DELETE FROM cola_cache WHERE upc = ?").run(upc);
    db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(upc);
    db.prepare("DELETE FROM import_queue WHERE upc = ?").run(upc);
  }
  db.prepare("DELETE FROM admin_audit_events WHERE action_type = 'inventory_item_deleted'").run();
}

function insertBeer(upc = BEER_UPC): number {
  return Number(db.prepare(`
    INSERT INTO packaged_beer (brewery, name, style, abv, upc, count)
    VALUES ('Yuengling', 'PR114 Delete Beer', 'Lager', 4.5, ?, 1)
  `).run(upc).lastInsertRowid);
}

function seedEntityArtifacts(entityId: number, upc: string): void {
  db.prepare(`
    INSERT INTO enrichment_jobs (entity_type, entity_id, upc, job_type, status)
    VALUES ('packaged_beer', ?, ?, 'metadata', 'completed')
  `).run(entityId, upc);
  db.prepare(`
    INSERT INTO product_content (entity_type, entity_id, official_tasting_notes)
    VALUES ('packaged_beer', ?, 'Clean lager')
  `).run(entityId);
  db.prepare(`
    INSERT INTO product_images (entity_type, entity_id, url)
    VALUES ('packaged_beer', ?, '/api/media/images/pr114.jpg')
  `).run(entityId);
  db.prepare(`
    INSERT INTO product_field_ownership (entity_type, entity_id, field, ownership, source)
    VALUES ('packaged_beer', ?, 'category', 'machine', 'official_brewery')
  `).run(entityId);
  db.prepare(`
    INSERT INTO enrichment_sources (entity_type, entity_id, source_type, source_url, discovered_at)
    VALUES ('packaged_beer', ?, 'official_product_page', 'https://yuengling.com/our-beer/traditional-lager/', CURRENT_TIMESTAMP)
  `).run(entityId);
  db.prepare(`
    INSERT INTO official_image_repair_requests (entity_type, entity_id, match_quality)
    VALUES ('packaged_beer', ?, 'exact_name')
  `).run(entityId);
}

function seedCaches(upc: string): void {
  db.prepare(`INSERT INTO barcode_cache (upc, name, brand, category) VALUES (?, 'PR114 Beer', 'Yuengling', 'Lager')`).run(upc);
  db.prepare(`INSERT INTO cola_cache (upc, name) VALUES (?, 'PR114 Beer')`).run(upc);
  db.prepare(`INSERT INTO beer_cache (upc, brewery, name) VALUES (?, 'Yuengling', 'PR114 Beer')`).run(upc);
  db.prepare(`INSERT INTO import_queue (upc, kind, table_name) VALUES (?, 'beer', 'packaged_beer')`).run(upc);
}

test("safe Remove atomically clears item artifacts and an unused UPC cache", async () => {
  cleanup();
  const id = insertBeer();
  seedEntityArtifacts(id, BEER_UPC);
  seedCaches(BEER_UPC);
  db.prepare("INSERT INTO reviews (table_name, item_id, author, body) VALUES ('packaged_beer', ?, 'A', 'B')").run(id);
  db.prepare("INSERT INTO votes (table_name, item_id, voter_key, value) VALUES ('packaged_beer', ?, 'voter_123', 1)").run(id);
  db.prepare("INSERT INTO daily_votes (target_table, item_id, patron_name, vote_date, value) VALUES ('packaged_beer', ?, 'Patron', '2026-09-06', 1)").run(id);
  db.prepare("INSERT INTO restock_got (key) VALUES (?)").run(`packaged_beer:${id}`);
  db.prepare("INSERT INTO pours (module, item_id, name, amount) VALUES ('packaged_beer', ?, 'PR114 Historical Pour', 'Bottle')").run(id);

  const response = await app.inject({
    method: "DELETE",
    url: `/api/inventory/packaged_beer/${id}`,
    headers: { authorization: `Bearer ${createTestAdminToken()}` }
  });
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(count("SELECT COUNT(*) AS count FROM packaged_beer WHERE id = ?", id), 0);
  for (const table of [
    "enrichment_jobs",
    "product_content",
    "product_images",
    "product_field_ownership",
    "enrichment_sources",
    "official_image_repair_requests"
  ]) {
    assert.equal(count(`SELECT COUNT(*) AS count FROM ${table} WHERE entity_type = 'packaged_beer' AND entity_id = ?`, id), 0, table);
  }
  assert.equal(count("SELECT COUNT(*) AS count FROM reviews WHERE table_name = 'packaged_beer' AND item_id = ?", id), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM votes WHERE table_name = 'packaged_beer' AND item_id = ?", id), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM daily_votes WHERE target_table = 'packaged_beer' AND item_id = ?", id), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM restock_got WHERE key = ?", `packaged_beer:${id}`), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM pours WHERE module = 'packaged_beer' AND item_id = ?", id), 1);
  for (const table of ["barcode_cache", "cola_cache", "beer_cache", "import_queue"]) {
    assert.equal(count(`SELECT COUNT(*) AS count FROM ${table} WHERE upc = ?`, BEER_UPC), 0, table);
  }
  const audit = getLatestAdminAuditEvent("inventory_item_deleted");
  assert.equal(audit?.detail.table, "packaged_beer");
  assert.equal(audit?.detail.entityId, id);
  assert.equal(audit?.detail.cacheEvicted, true);
  cleanup();
});

test("Remove preserves UPC caches while an equivalent alias remains on another shelf", async () => {
  cleanup();
  const beerId = insertBeer(SPIRIT_UPC);
  const spiritId = Number(db.prepare(`
    INSERT INTO spirits (name, brand, category, upc)
    VALUES ('PR114 Shared Spirit', 'Shared', 'Whiskey', ?)
  `).run(`0${SPIRIT_UPC}`).lastInsertRowid);
  seedCaches(SPIRIT_UPC);

  const response = await app.inject({
    method: "DELETE",
    url: `/api/inventory/packaged_beer/${beerId}`,
    headers: { authorization: `Bearer ${createTestAdminToken()}` }
  });
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(count("SELECT COUNT(*) AS count FROM spirits WHERE id = ?", spiritId), 1);
  for (const table of ["barcode_cache", "cola_cache", "beer_cache", "import_queue"]) {
    assert.equal(count(`SELECT COUNT(*) AS count FROM ${table} WHERE upc = ?`, SPIRIT_UPC), 1, table);
  }
  assert.equal(getLatestAdminAuditEvent("inventory_item_deleted")?.detail.cacheEvicted, false);
  cleanup();
});

test("Remove refuses a running enrichment job, then cancels it once pending", async () => {
  cleanup();
  const id = Number(db.prepare(`
    INSERT INTO spirits (name, brand, category, upc)
    VALUES ('PR114 Busy Spirit', 'Busy', 'Whiskey', ?)
  `).run(SPIRIT_UPC).lastInsertRowid);
  db.prepare(`
    INSERT INTO enrichment_jobs (entity_type, entity_id, upc, job_type, status)
    VALUES ('spirits', ?, ?, 'metadata', 'running')
  `).run(id, SPIRIT_UPC);
  const headers = { authorization: `Bearer ${createTestAdminToken()}` };

  const busy = await app.inject({ method: "DELETE", url: `/api/inventory/spirits/${id}`, headers });
  assert.equal(busy.statusCode, 409);
  assert.match(String(busy.json().error), /still running/i);
  assert.equal(count("SELECT COUNT(*) AS count FROM spirits WHERE id = ?", id), 1);

  db.prepare("UPDATE enrichment_jobs SET status = 'pending' WHERE entity_type = 'spirits' AND entity_id = ?").run(id);
  const removed = await app.inject({ method: "DELETE", url: `/api/inventory/spirits/${id}`, headers });
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(count("SELECT COUNT(*) AS count FROM spirits WHERE id = ?", id), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM enrichment_jobs WHERE entity_type = 'spirits' AND entity_id = ?", id), 0);
  cleanup();
});

test("invalid historical UPC cleanup never invents padded aliases", () => {
  assert.deepEqual(verifiedInventoryUpcAliases("00899247"), ["00899247"]);
  assert.ok(verifiedInventoryUpcAliases(BEER_UPC).includes(BEER_UPC));
});
