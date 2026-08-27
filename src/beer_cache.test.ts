import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beerCacheToProduct,
  getBeerCacheEntry,
  saveBeerCacheEntry,
  searchBeerCache
} from "./beer_cache.js";
import { db } from "./db.js";

test("beer cache round-trips UPC lookup and text search", () => {
  const upc = "001234567890";
  db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(upc);
  saveBeerCacheEntry({
    upc,
    catalog_beer_id: "abc-123",
    brewery: "Troegs",
    name: "Perpetual IPA",
    style: "American IPA",
    abv: 7.5,
    source: "catalog_beer"
  });
  const entry = getBeerCacheEntry(upc);
  assert.ok(entry);
  assert.equal(entry?.name, "Perpetual IPA");
  assert.equal(entry?.brewery, "Troegs");
  const product = beerCacheToProduct(entry!);
  assert.equal(product.brand, "Troegs");
  assert.equal(product.category, "American IPA");
  const hits = searchBeerCache("troegs perpetual");
  assert.ok(hits.some((hit) => hit.upc === upc));
});
