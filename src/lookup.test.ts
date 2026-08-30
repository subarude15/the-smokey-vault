import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { saveBarcodeCacheEntry, searchBarcodeCache } from "./barcode_cache.js";
import { importTableFor } from "./import_batch.js";
import { colaProductTypeForTable, foldSearch, getFromCache, inferImportKind, lookupProductWithSmartFallback, matchesQuery, parseProductSchema, queryTokens, rememberUnresolvedUpc, saveToCache, searchBottles, searchTableForModule, searchTablesForModule, searchVault, searchWebSnippets } from "./lookup.js";

test("foldSearch strips diacritics so troegs matches Tröegs", () => {
  assert.equal(foldSearch("Tröegs"), "troegs");
  assert.deepEqual(queryTokens("troegs nug"), ["troegs", "nug"]);
});

test("matchesQuery requires every token across name and maker", () => {
  const beer = { name: "Nugget Nectar", brewery: "Tröegs Independent Brewing", style: "Imperial Amber" };
  assert.equal(matchesQuery(beer, "troegs nug"), true);
  assert.equal(matchesQuery(beer, "nugget"), true);
  assert.equal(matchesQuery(beer, "lagavulin"), false);
  assert.equal(matchesQuery({ name: "Eagle Rare 10 Year", brand: "Buffalo Trace" }, "eag rar"), true);
});

test("parseProductSchema normalizes Ollama JSON product output", () => {
  const product = parseProductSchema(`\`\`\`json
{
  "upc": "082184090452",
  "name": "Nugget Nectar",
  "brand": "Troegs Independent Brewing",
  "category": "Imperial Amber Ale",
  "abv": "7.5%",
  "image_url": "",
  "fill_level_percent": 100,
  "bottle_count": 1,
  "notes": "Seasonal beer",
  "volume_ml": "12 fl oz",
  "product_type": "beer",
  "ttb_id": "",
  "origin": "",
  "approval_date": ""
}
\`\`\``);
  assert.equal(product.upc, "082184090452");
  assert.equal(product.abv, 7.5);
  assert.equal(product.volume_ml, 355);
  assert.equal(product.image_url, null);
  assert.equal(product.product_type, "beer");
});

test("searchWebSnippets formats SearXNG title/content and returns empty on failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /192\.168\.1\.184:8888\/search/);
    assert.match(url, /format=json/);
    assert.match(url, /q=/);
    return new Response(JSON.stringify({
      results: [
        { title: "Nugget Nectar", content: "7.5% ABV Imperial Amber Ale from Troegs" },
        { title: "Other", content: "" }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const snippets = await searchWebSnippets("Nugget Nectar beer abv style description", 5);
    assert.match(snippets, /1\. Nugget Nectar — 7\.5% ABV Imperial Amber Ale from Troegs/);
    assert.match(snippets, /2\. Other/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    assert.equal(await searchWebSnippets("anything"), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lookupProductWithSmartFallback uses catalog hits before SearXNG", async () => {
  const product = await lookupProductWithSmartFallback(
    { upc: "082184090452" },
    {
      lookupByUpc: async () => ({
        source: "fwgs",
        upc: "082184090452",
        product: {
          upc: "082184090452",
          name: "Nugget Nectar",
          brand: "Troegs",
          category: "Beer",
          abv: 7.5,
          fill_level: 100,
          stock_count: 1,
          volume_ml: 355
        }
      }),
      searchWeb: async () => {
        throw new Error("should not search the web");
      },
      extractFromText: async () => {
        throw new Error("should not call Ollama");
      }
    }
  );
  assert.equal(product?.name, "Nugget Nectar");
  assert.equal(product?.upc, "082184090452");
  assert.equal(product?.abv, 7.5);
});

test("lookupProductWithSmartFallback parses SearXNG text through Ollama when catalogs miss", async () => {
  let searched = "";
  const product = await lookupProductWithSmartFallback(
    { upc: "099988877766", name: "Local Lager" },
    {
      lookupByUpc: async () => ({
        source: "not_found",
        upc: "099988877766",
        product: { name: "" },
        reason: "no_catalog"
      }),
      searchByName: async () => ({ results: [] }),
      searchWeb: async (query) => {
        searched = query;
        return "1. Local Lager — Neighborhood Brewing 5.2% ABV lager";
      },
      extractFromText: async (raw) => parseProductSchema({
        upc: "",
        name: "Local Lager",
        brand: "Neighborhood Brewing",
        category: "Lager",
        abv: 5.2,
        image_url: null,
        fill_level_percent: 100,
        bottle_count: 1,
        notes: raw,
        volume_ml: 355,
        product_type: "beer",
        ttb_id: null,
        origin: null,
        approval_date: null
      })
    }
  );
  assert.match(searched, /Local Lager 099988877766 beer abv style description/);
  assert.equal(product?.name, "Local Lager");
  assert.equal(product?.brand, "Neighborhood Brewing");
  assert.equal(product?.upc, "099988877766");
});

test("lookupProductWithSmartFallback returns null when no catalog or web data exists", async () => {
  const product = await lookupProductWithSmartFallback(
    { name: "Unknown Bottle" },
    {
      searchByName: async () => ({ results: [] }),
      searchWeb: async () => "",
      extractFromText: async () => {
        throw new Error("should not call Ollama");
      }
    }
  );
  assert.equal(product, null);
});

test("searchVault can stay inside packaged beer and ignore liquor", () => {
  const beer = db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Tröegs Independent Brewing", "Nugget Nectar", "Imperial Amber", 7.5);
  const spirit = db.prepare(
    "INSERT INTO spirits(name, brand, category, abv) VALUES(?, ?, ?, ?)"
  ).run("Nugget Whiskey", "Tröegs", "Whiskey", 45);
  try {
    const beerHits = searchVault("troegs nug", "packaged_beer");
    assert.equal(beerHits.every((hit) => hit.table === "packaged_beer"), true);
    assert.ok(beerHits.some((hit) => String(hit.product.name) === "Nugget Nectar"));
    assert.equal(beerHits.some((hit) => String(hit.product.name) === "Nugget Whiskey"), false);
  } finally {
    db.prepare("DELETE FROM packaged_beer WHERE id=?").run(beer.lastInsertRowid);
    db.prepare("DELETE FROM spirits WHERE id=?").run(spirit.lastInsertRowid);
  }
});

test("searchTableForModule maps taps to beer and COLA malt beverage", () => {
  assert.equal(searchTableForModule("taps"), "packaged_beer");
  assert.deepEqual(searchTablesForModule("taps"), ["brews", "packaged_beer"]);
  assert.equal(searchTableForModule("brews"), "packaged_beer");
  assert.deepEqual(searchTablesForModule("brews"), ["packaged_beer"]);
  assert.equal(searchTableForModule("packaged_beer"), "packaged_beer");
  assert.equal(searchTableForModule("spirits"), "spirits");
  assert.equal(colaProductTypeForTable("packaged_beer"), "malt beverage");
  assert.equal(colaProductTypeForTable("spirits"), "distilled spirits");
  assert.equal(colaProductTypeForTable("wines"), "wine");
});

test("unresolved UPCs stay in cache so a later match can fill the barcode", () => {
  const upc = "012345678905";
  try {
    rememberUnresolvedUpc(upc);
    const pending = db.prepare("SELECT upc, name, source FROM cola_cache WHERE upc = ?").get(upc) as { upc: string; name: string; source: string } | undefined;
    assert.equal(pending?.upc, upc);
    assert.equal(pending?.source, "pending");
    assert.equal(pending?.name, "");
    assert.equal(getFromCache(upc), null);

    saveToCache({
      upc,
      name: "Eagle Rare 10 Year",
      brand: "Buffalo Trace",
      category: "Whiskey",
      abv: 45,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "DISTILLED SPIRITS",
      ttb_id: "ttb-test",
      origin: null,
      approval_date: null
    }, null, null, "cola_cloud");

    const filled = getFromCache(upc);
    assert.equal(filled?.name, "Eagle Rare 10 Year");
    assert.equal(filled?.upc, upc);
    rememberUnresolvedUpc(upc);
    assert.equal(getFromCache(upc)?.name, "Eagle Rare 10 Year");
  } finally {
    db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  }
});

test("searchVault includes brewery lab batches when filling a tap", () => {
  const brew = db.prepare(
    "INSERT INTO brews(batch_name, maker, style, calculated_abv, status) VALUES(?, ?, ?, ?, ?)"
  ).run("Vault IPA", "Nick", "IPA", 6.4, "Ready to Keg");
  try {
    const hits = searchVault("vault ipa", ["brews", "packaged_beer"]);
    assert.ok(hits.some((hit) => hit.table === "brews" && String(hit.product.batch_name) === "Vault IPA"));
  } finally {
    db.prepare("DELETE FROM brews WHERE id=?").run(brew.lastInsertRowid);
  }
});

test("inferImportKind trusts explicit TTB type over a beer scanner hint", () => {
  const kind = inferImportKind({
    name: "Buffalo Trace",
    category: "Bourbon",
    product_type: "DISTILLED SPIRITS"
  }, "beer");
  assert.equal(kind, "spirits");
});

test("inferImportKind still honors a beer hint for ambiguous products", () => {
  const kind = inferImportKind({ name: "Mystery Can", category: "Beverages" }, "beer");
  assert.equal(kind, "beer");
});

test("importTableFor keeps single malt whiskey out of packaged beer", () => {
  assert.equal(importTableFor({ name: "Lagavulin 16", category: "Single Malt Scotch" }), "spirits");
  assert.equal(importTableFor({ name: "Troegs Nugget Nectar", style: "Imperial Amber Ale" }), "packaged_beer");
});

test("searchBarcodeCache finds prior scans by name", () => {
  const upc = "080244009365";
  try {
    saveBarcodeCacheEntry({
      upc,
      name: "Eagle Rare 10 Year",
      brand: "Buffalo Trace",
      category: "Spirit",
      subcategory: "Bourbon",
      abv: 45,
      proof: 90,
      volume_ml: 750,
      description: "",
      image_url: "",
      source: "fwgs"
    });
    const hits = searchBarcodeCache("eagle rare", 8);
    assert.ok(hits.some((hit) => hit.name === "Eagle Rare 10 Year"));
  } finally {
    db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  }
});

test("searchBottles merges barcode cache hits for spirits", async () => {
  const upc = "080686000123";
  try {
    saveBarcodeCacheEntry({
      upc,
      name: "Catalog Search Bourbon",
      brand: "Test Distillery",
      category: "Spirit",
      subcategory: "Bourbon",
      abv: 40,
      proof: 80,
      volume_ml: 750,
      description: "",
      image_url: "",
      source: "imported"
    });
    const { results } = await searchBottles("catalog search bourbon", { table: "spirits" });
    assert.ok(results.some((hit) => hit.source === "cache" && String(hit.product.name) === "Catalog Search Bourbon"));
  } finally {
    db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  }
});
