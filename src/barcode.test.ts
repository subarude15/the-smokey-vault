import assert from "node:assert/strict";
import { test } from "node:test";
import { aiBarcodePrompt, parseAiBarcode } from "./ai_barcode.js";
import { barcodeEntryToProduct, getBarcodeCacheEntry, saveBarcodeCacheEntry } from "./barcode_cache.js";
import {
  combineImportNotes, importTableFor, normalizeImportAbv, normalizeImportItem,
  normalizeImportProof, normalizeImportUpc, readImportPayload
} from "./import_batch.js";
import { lookupProduct } from "./lookup.js";
import { db } from "./db.js";

function clearBarcodeCache() {
  db.prepare("DELETE FROM barcode_cache").run();
}

test("the AI prompt names the barcode and pins the JSON shape", () => {
  const prompt = aiBarcodePrompt("080686000891");
  assert.match(prompt, /080686000891/);
  assert.match(prompt, /"image_url":""/);
});

test("parseAiBarcode reads a fenced answer and fills proof from abv", () => {
  const parsed = parseAiBarcode('```json\n{"name":"Buffalo Trace","brand":"Buffalo Trace","category":"Whiskey","subcategory":"Bourbon","abv":45,"volume_ml":750,"image_url":"https://cdn.example.com/bt.jpg"}\n```', "80686000891");
  assert.ok(parsed);
  assert.equal(parsed.name, "Buffalo Trace");
  assert.equal(parsed.subcategory, "Bourbon");
  assert.equal(parsed.abv, 45);
  assert.equal(parsed.proof, 90);
  assert.equal(parsed.volume_ml, 750);
  assert.equal(parsed.upc, "080686000891");
});

test("parseAiBarcode derives abv when only proof comes back", () => {
  const parsed = parseAiBarcode('{"name":"Wild Turkey 101","proof":101}', "080480010102");
  assert.equal(parsed?.abv, 50.5);
  assert.equal(parsed?.proof, 101);
});

test("parseAiBarcode keeps a bare millilitre number instead of defaulting", () => {
  assert.equal(parseAiBarcode('{"name":"Big Bottle","volume_ml":1750}', "012345678905")?.volume_ml, 1750);
  assert.equal(parseAiBarcode('{"name":"Half Bottle","volume_ml":"375 mL"}', "012345678905")?.volume_ml, 375);
});

test("parseAiBarcode drops anything but an https product photo", () => {
  assert.equal(parseAiBarcode('{"name":"A","image_url":"http://insecure.example/x.jpg"}', "012345678905")?.image_url, "");
  assert.equal(parseAiBarcode('{"name":"A","image_url":"/etc/passwd"}', "012345678905")?.image_url, "");
  assert.equal(parseAiBarcode('{"name":"A","image_url":"https://ok.example/x.jpg"}', "012345678905")?.image_url, "https://ok.example/x.jpg");
});

test("parseAiBarcode refuses junk and empty names", () => {
  assert.equal(parseAiBarcode("I could not find that bottle.", "012345678905"), null);
  assert.equal(parseAiBarcode('{"name":"   "}', "012345678905"), null);
  assert.equal(parseAiBarcode("", "012345678905"), null);
  assert.equal(parseAiBarcode("[]", "012345678905"), null);
});

test("parseAiBarcode digs the object out of prose or a one-item array", () => {
  assert.equal(parseAiBarcode('Sure! {"name":"Tanqueray","abv":47.3} Hope that helps.', "012345678905")?.name, "Tanqueray");
  assert.equal(parseAiBarcode('[{"name":"Tanqueray"}]', "012345678905")?.name, "Tanqueray");
});

test("barcode cache round-trips and normalizes the UPC on the way in", () => {
  try {
    saveBarcodeCacheEntry({ upc: "80686000891", name: "Buffalo Trace", brand: "Sazerac", category: "Whiskey", subcategory: "Bourbon", abv: 45, volume_ml: 750, source: "ai" });
    const entry = getBarcodeCacheEntry("080686000891");
    assert.equal(entry?.name, "Buffalo Trace");
    assert.equal(entry?.proof, 90, "proof is filled in from abv when not supplied");
    assert.equal(entry?.source, "ai");
    // A padded scan of the same code finds the same row.
    assert.equal(getBarcodeCacheEntry("80686000891")?.upc, "080686000891");
  } finally {
    clearBarcodeCache();
  }
});

test("saving a barcode twice updates in place rather than duplicating", () => {
  try {
    saveBarcodeCacheEntry({ upc: "012345678905", name: "First Guess", category: "Other" });
    saveBarcodeCacheEntry({ upc: "012345678905", name: "Confirmed Bottle", category: "Whiskey", source: "imported" });
    assert.equal(getBarcodeCacheEntry("012345678905")?.name, "Confirmed Bottle");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM barcode_cache").get() as { c: number }).c, 1);
  } finally {
    clearBarcodeCache();
  }
});

test("barcode cache entries without a name or code are not stored", () => {
  try {
    assert.equal(saveBarcodeCacheEntry({ upc: "012345678905", name: "  " }), null);
    assert.equal(saveBarcodeCacheEntry({ upc: "", name: "Nameless code" }), null);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM barcode_cache").get() as { c: number }).c, 0);
  } finally {
    clearBarcodeCache();
  }
});

test("a cached entry prefers its subcategory as the shelf label", () => {
  const product = barcodeEntryToProduct({
    upc: "012345678905", name: "Lagavulin 16", brand: "Lagavulin", category: "Whiskey",
    subcategory: "Islay Single Malt", abv: 43, proof: 86, volume_ml: 750, description: "Peated", image_url: "", source: "ai"
  });
  assert.equal(product.category, "Islay Single Malt");
  assert.equal(product.notes, "Peated");
  assert.equal(product.abv, 43);
});

test("a cached barcode resolves before any web tier is consulted", async () => {
  try {
    saveBarcodeCacheEntry({
      upc: "080686000891", name: "Buffalo Trace", brand: "Sazerac", category: "Whiskey",
      subcategory: "Bourbon", abv: 45, volume_ml: 750, description: "House bourbon", source: "ai"
    });
    // No `ai` resolver is passed, and COLA/Open Food Facts are never reached on a cache hit.
    const result = await lookupProduct("80686000891");
    assert.equal(result.source, "cache");
    assert.equal(result.table, "spirits");
    assert.equal(result.product?.name, "Buffalo Trace");
    assert.equal(result.product?.sub_category, "Bourbon");
    assert.equal(result.product?.abv, 45);
  } finally {
    clearBarcodeCache();
  }
});

test("a vault bottle still outranks the barcode cache", async () => {
  try {
    db.prepare("INSERT INTO spirits (name, category, upc) VALUES (?, ?, ?)").run("Shelf Copy", "Whiskey", "080686000891");
    saveBarcodeCacheEntry({ upc: "080686000891", name: "Catalog Copy", category: "Whiskey" });
    const result = await lookupProduct("080686000891");
    assert.equal(result.source, "vault");
    assert.equal(result.product?.name, "Shelf Copy");
  } finally {
    db.prepare("DELETE FROM spirits WHERE upc = '080686000891'").run();
    clearBarcodeCache();
  }
});

test("import rows land on the table their category implies", () => {
  assert.equal(importTableFor({ category: "Bourbon" }), "spirits");
  assert.equal(importTableFor({ category: "Hazy IPA" }), "packaged_beer");
  assert.equal(importTableFor({ subcategory: "Cabernet Sauvignon" }), "wines");
  assert.equal(importTableFor({ table: "wines", category: "Bourbon" }), "wines", "an explicit table wins");
});

test("import UPCs survive hyphens, spaces, and short codes", () => {
  assert.equal(normalizeImportUpc(" 0-80686-00089-1 "), "080686000891");
  assert.equal(normalizeImportUpc("80686000891"), "080686000891");
  assert.equal(normalizeImportUpc(""), "");
  assert.equal(normalizeImportUpc(null), "");
});

test("a fractional abv is read as a percentage", () => {
  assert.equal(normalizeImportAbv(0.43), 43);
  assert.equal(normalizeImportAbv(1), 100);
  assert.equal(normalizeImportAbv(43), 43);
  assert.equal(normalizeImportAbv("40.5%"), 40.5);
});

test("a missing abv stays null instead of becoming zero proof", () => {
  assert.equal(normalizeImportAbv(null), null);
  assert.equal(normalizeImportAbv(undefined), null);
  assert.equal(normalizeImportAbv(0), null);
  assert.equal(normalizeImportProof(undefined, null), null);
  assert.equal(normalizeImportProof(undefined, 45), 90);
  assert.equal(normalizeImportProof(101, 50), 101, "a stated proof wins over the doubled abv");
});

test("flavour profiles are folded into the notes", () => {
  assert.equal(combineImportNotes("Sweet corn nose.", ["vanilla", "oak", "caramel"]), "Sweet corn nose.\n\nNotes: vanilla, oak, caramel");
  assert.equal(combineImportNotes("", ["vanilla"]), "Notes: vanilla");
  assert.equal(combineImportNotes("Just a description.", []), "Just a description.");
  assert.equal(combineImportNotes("", undefined), "");
});

test("volume falls back to 750 for bottles and 355 for beer", () => {
  assert.equal(normalizeImportItem({ name: "No Size Whiskey", category: "Bourbon" })?.cache.volume_ml, 750);
  assert.equal(normalizeImportItem({ name: "No Size Wine", category: "Wine" })?.cache.volume_ml, 750);
  assert.equal(normalizeImportItem({ name: "No Size Beer", category: "Beer" })?.cache.volume_ml, 355);
  assert.equal(normalizeImportItem({ name: "Tallboy", category: "Beer", volume_ml: 473 })?.cache.volume_ml, 473);
});

test("brand resolves through brand_or_producer and producer", () => {
  assert.equal(normalizeImportItem({ name: "A", brand_or_producer: "House Distillery" })?.cache.brand, "House Distillery");
  assert.equal(normalizeImportItem({ name: "A", producer: "Vietti" })?.cache.brand, "Vietti");
  assert.equal(normalizeImportItem({ name: "A", brand: "First", producer: "Second" })?.cache.brand, "First");
});

test("a row with no strength leaves abv out of the insert entirely", () => {
  const row = normalizeImportItem({ name: "Mystery Amaro", category: "Liqueur" });
  assert.equal(row?.table, "spirits");
  assert.equal(row?.values.abv, undefined, "the column default stands rather than a fabricated 0%");
  assert.equal(row?.cache.abv, null);
  assert.equal(row?.cache.proof, null);
});

test("a spirit import row maps onto vault columns", () => {
  const row = normalizeImportItem({ upc: "80686000891", name: "Buffalo Trace", brand: "Sazerac", category: "Bourbon", abv: "45%", volume_ml: 750, stock_count: 2 });
  assert.equal(row?.table, "spirits");
  assert.equal(row?.values.name, "Buffalo Trace");
  assert.equal(row?.values.category, "Whiskey");
  assert.equal(row?.values.sub_category, "Bourbon");
  assert.equal(row?.values.abv, 45);
  assert.equal(row?.values.stock_count, 2);
  assert.equal(row?.values.upc, "080686000891");
  assert.equal(row?.cache.proof, 90);
});

test("beer and wine rows use their own column names", () => {
  const beer = normalizeImportItem({ name: "Sip of Sunshine", brand: "Lawson's", style: "IPA", abv: 8, count: 4 });
  assert.equal(beer?.table, "packaged_beer");
  assert.equal(beer?.values.brewery, "Lawson's");
  assert.equal(beer?.values.count, 4);
  assert.equal(beer?.values.vessel, "Can");

  const wine = normalizeImportItem({ name: "Barolo", producer: "Vietti", varietal: "Nebbiolo", vintage: 2018, type: "Red", table: "wines" });
  assert.equal(wine?.values.producer, "Vietti");
  assert.equal(wine?.values.vintage, 2018);
  assert.equal(wine?.values.bottle_count, 1);
});

test("import rows without a name are rejected, and a bad vintage is dropped", () => {
  assert.equal(normalizeImportItem({ brand: "No Name" }), null);
  assert.equal(normalizeImportItem("nope"), null);
  assert.equal(normalizeImportItem({ name: "Mystery Wine", table: "wines", vintage: "soon" })?.values.vintage, null);
});

test("the import payload reader accepts an array or a wrapped object", () => {
  assert.equal(readImportPayload([{ name: "A" }]).length, 1);
  assert.equal(readImportPayload({ items: [{ name: "A" }, { name: "B" }] }).length, 2);
  assert.equal(readImportPayload({ rows: [{ name: "A" }] }).length, 1);
  assert.equal(readImportPayload({ nope: 1 }).length, 0);
  assert.equal(readImportPayload(null).length, 0);
});
