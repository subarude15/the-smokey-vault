import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { colaProductTypeForTable, foldSearch, matchesQuery, queryTokens, searchTableForModule, searchTablesForModule, searchVault } from "./lookup.js";

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
  assert.equal(searchTableForModule("packaged_beer"), "packaged_beer");
  assert.equal(searchTableForModule("spirits"), "spirits");
  assert.equal(colaProductTypeForTable("packaged_beer"), "malt beverage");
  assert.equal(colaProductTypeForTable("spirits"), "distilled spirits");
  assert.equal(colaProductTypeForTable("wines"), "wine");
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
