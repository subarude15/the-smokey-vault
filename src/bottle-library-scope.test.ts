import assert from "node:assert/strict";
import { test } from "node:test";
import { spiritInventoryRowLooksLikeBeer } from "./catalog.js";
import { db } from "./db.js";
import { previewInventoryCleanup } from "./inventory-cleanup-preview.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken } = await import("./server.js");

const TEST_NAMES = ["PR116 DirtWolf", "PR116 Whiskey", "PR116 Existing Spirit"];

function cleanup(): void {
  db.prepare(`DELETE FROM spirits WHERE name IN (${TEST_NAMES.map(() => "?").join(",")})`).run(...TEST_NAMES);
}

test("Bottle Library classifier catches beer styles without confusing whiskey", () => {
  assert.equal(spiritInventoryRowLooksLikeBeer({ name: "DirtWolf", category: "Double IPA" }), true);
  assert.equal(spiritInventoryRowLooksLikeBeer({ name: "Sour Monkey", category: "Belgian Tripel" }), true);
  assert.equal(spiritInventoryRowLooksLikeBeer({ name: "Beer Barrel Bourbon", category: "Whiskey", sub_category: "Bourbon" }), false);
  assert.equal(spiritInventoryRowLooksLikeBeer({ name: "Single Malt", category: "Whiskey", sub_category: "Scotch Whisky" }), false);
});

test("Keeper cannot create or turn a Spirits row into packaged beer", async () => {
  cleanup();
  const headers = { authorization: `Bearer ${createTestAdminToken()}` };

  const rejectedCreate = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers,
    payload: { name: "PR116 DirtWolf", brand: "Victory", category: "Double IPA", abv: 8.7 }
  });
  assert.equal(rejectedCreate.statusCode, 400, rejectedCreate.body);
  assert.match(String(rejectedCreate.json().error), /Packaged Beer/i);
  assert.equal(db.prepare("SELECT 1 FROM spirits WHERE name = 'PR116 DirtWolf'").get(), undefined);

  const acceptedSpirit = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers,
    payload: { name: "PR116 Existing Spirit", brand: "Keeper", category: "Whiskey", sub_category: "Bourbon", abv: 45 }
  });
  assert.equal(acceptedSpirit.statusCode, 201, acceptedSpirit.body);
  const spiritId = Number(acceptedSpirit.json().id);

  const rejectedUpdate = await app.inject({
    method: "PUT",
    url: `/api/inventory/spirits/${spiritId}`,
    headers,
    payload: { category: "Lager" }
  });
  assert.equal(rejectedUpdate.statusCode, 400, rejectedUpdate.body);
  const unchanged = db.prepare("SELECT category FROM spirits WHERE id = ?").get(spiritId) as { category: string };
  assert.equal(unchanged.category, "Whiskey");
  cleanup();
});

test("cleanup preview identifies historical beer-like rows already filed as spirits", () => {
  cleanup();
  const baseline = previewInventoryCleanup().beerLikeSpiritRows.count;
  const id = Number(db.prepare(`
    INSERT INTO spirits (name, brand, category, sub_category, abv)
    VALUES ('PR116 DirtWolf', 'Victory', 'Beer', 'Double IPA', 8.7)
  `).run().lastInsertRowid);

  const preview = previewInventoryCleanup();
  assert.equal(preview.beerLikeSpiritRows.count, baseline + 1);
  assert.ok(preview.beerLikeSpiritRows.items.some((item) => item.entityId === id));
  assert.equal(db.prepare("SELECT name FROM spirits WHERE id = ?").pluck().get(id), "PR116 DirtWolf");
  cleanup();
});
