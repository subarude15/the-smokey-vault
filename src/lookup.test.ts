import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { foldSearch, matchesQuery, queryTokens, searchVault } from "./lookup.js";

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

test("searchVault finds a beer from a partial brand plus name", () => {
  const inserted = db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Tröegs Independent Brewing", "Nugget Nectar", "Imperial Amber", 7.5);
  try {
    const hits = searchVault("troegs nug");
    assert.ok(hits.some((hit) => String(hit.product.name) === "Nugget Nectar" && hit.table === "packaged_beer"));
  } finally {
    db.prepare("DELETE FROM packaged_beer WHERE id=?").run(inserted.lastInsertRowid);
  }
});
