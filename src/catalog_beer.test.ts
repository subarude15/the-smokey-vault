import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogBeerToInventoryFields,
  catalogBeerToSchema,
  resetCatalogBeerQuota,
  searchCatalogBeers
} from "./catalog_beer.js";

test("catalog beer mapper maps brewery style and abv", () => {
  const product = catalogBeerToSchema({
    id: "beer-1",
    name: "Perpetual IPA",
    style: "American IPA",
    abv: 7.5,
    brewer: { id: "brew-1", name: "Tröegs Brewing Company" }
  }, "001234567890");
  assert.equal(product.name, "Perpetual IPA");
  assert.equal(product.brand, "Tröegs Brewing Company");
  assert.equal(product.category, "American IPA");
  assert.equal(product.abv, 7.5);
  const fields = catalogBeerToInventoryFields({
    id: "beer-1",
    name: "Perpetual IPA",
    style: "American IPA",
    abv: 7.5,
    brewer: { name: "Tröegs Brewing Company" }
  }, "001234567890");
  assert.equal(fields.brewery, "Tröegs Brewing Company");
  assert.equal(fields.catalog_beer_id, "beer-1");
});

test("searchCatalogBeers returns empty without API key", async () => {
  const previous = process.env.CATALOG_BEER_API_KEY;
  delete process.env.CATALOG_BEER_API_KEY;
  resetCatalogBeerQuota();
  try {
    const hits = await searchCatalogBeers("ipa");
    assert.equal(hits.length, 0);
  } finally {
    if (previous == null) delete process.env.CATALOG_BEER_API_KEY;
    else process.env.CATALOG_BEER_API_KEY = previous;
    resetCatalogBeerQuota();
  }
});
