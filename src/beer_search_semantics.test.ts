/**
 * Packaged-beer name-search semantics — fixtures/stubs only.
 * No live Catalog.beer calls; no persistence side effects.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  classifyBeerMatch,
  damerauLevenshtein,
  foldBeerText,
  matchesBeerQuery,
  parseBeerQuery,
  rankBeerSearchHits,
  scoreBeerHit
} from "./beer_search_query.js";
import {
  clearCatalogBeerSearchCache,
  getCatalogBeerUsage,
  resetCatalogBeerQuota,
  searchCatalogBeers
} from "./catalog_beer.js";
import { db } from "./db.js";
import {
  LOCAL_BEER_SUFFICIENCY_THRESHOLD,
  searchBottles
} from "./lookup.js";

afterEach(() => {
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  delete process.env.CATALOG_BEER_API_KEY;
});

function hit(source: string, brewery: string, name: string, style = "") {
  return {
    source,
    table: "packaged_beer" as const,
    product: { brewery, brand: brewery, name, style, category: style }
  };
}

test("1. Yards Brawler ranks first over other Yards beers", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const ranked = rankBeerSearchHits(
    [
      hit("vault", "Yards Brewing Co.", "Philadelphia Pale Ale", "Pale Ale"),
      hit("vault", "Yards Brewing Co.", "Brawler", "English Mild"),
      hit("vault", "Yards Brewing Co.", "Loyal Lager", "Lager")
    ],
    parsed
  );
  assert.equal(String(ranked[0]?.product.name), "Brawler");
  assert.ok(
    scoreBeerHit(ranked[0]!.product, parsed, "vault") >
      scoreBeerHit(ranked[1]!.product, parsed, "vault") + 50
  );
});

test("2. Yards IPA matches India Pale Ale via style equivalence", () => {
  const parsed = parseBeerQuery("Yards IPA");
  assert.deepEqual(parsed.styleConcepts, ["ipa"]);
  assert.deepEqual(parsed.nonStyleTokens, ["yards"]);
  const candidate = { brewery: "Yards", name: "India Pale Ale", style: "India Pale Ale" };
  assert.equal(matchesBeerQuery(candidate, parsed), true);
  assert.ok(["name_and_brewery", "brewery_and_style", "name"].includes(classifyBeerMatch(candidate, parsed)));
});

test("3. Troegs folds to Tröegs", () => {
  assert.equal(foldBeerText("Tröegs"), "troegs");
  const parsed = parseBeerQuery("Troegs Perpetual IPA");
  const candidate = {
    brewery: "Tröegs Independent Brewing",
    name: "Perpetual IPA",
    style: "American IPA"
  };
  assert.equal(matchesBeerQuery(candidate, parsed), true);
  assert.ok(scoreBeerHit(candidate, parsed, "vault") > 700);
});

test("4. Dogfish Head 60 Minute IPA outranks other Dogfish beers", () => {
  const parsed = parseBeerQuery("Dogfish Head 60 Minute IPA");
  const ranked = rankBeerSearchHits(
    [
      hit("vault", "Dogfish Head", "90 Minute IPA", "IPA"),
      hit("vault", "Dogfish Head", "60 Minute IPA", "IPA"),
      hit("vault", "Dogfish Head", "120 Minute IPA", "IPA")
    ],
    parsed
  );
  assert.equal(String(ranked[0]?.product.name), "60 Minute IPA");
});

test("5. Sierra Nevada Pale Ale outranks other Sierra Nevada products", () => {
  const parsed = parseBeerQuery("Sierra Nevada Pale Ale");
  const ranked = rankBeerSearchHits(
    [
      hit("vault", "Sierra Nevada", "Torpedo Extra IPA", "IPA"),
      hit("vault", "Sierra Nevada", "Pale Ale", "Pale Ale"),
      hit("vault", "Sierra Nevada", "Hazy Little Thing", "Hazy IPA")
    ],
    parsed
  );
  assert.equal(String(ranked[0]?.product.name), "Pale Ale");
});

test("6. Bells Two Hearted apostrophe normalization", () => {
  const parsed = parseBeerQuery("Bells Two Hearted");
  const candidate = { brewery: "Bell's Brewery", name: "Two Hearted Ale", style: "IPA" };
  assert.equal(matchesBeerQuery(candidate, parsed), true);
});

test("7. Founders All Day IPA ranks strongly on name+brewery+style", () => {
  const parsed = parseBeerQuery("Founders All Day IPA");
  const candidate = { brewery: "Founders Brewing Co.", name: "All Day IPA", style: "Session IPA" };
  assert.equal(matchesBeerQuery(candidate, parsed), true);
  assert.ok(scoreBeerHit(candidate, parsed, "vault") > 800);
});

test("8. Voodoo Ranger matches without brewery", () => {
  const parsed = parseBeerQuery("Voodoo Ranger");
  const candidate = { brewery: "New Belgium", name: "Voodoo Ranger IPA", style: "IPA" };
  assert.equal(matchesBeerQuery(candidate, parsed), true);
  assert.ok(["name", "exact_identity"].includes(classifyBeerMatch(candidate, parsed)));
});

test("9. Victory Golden Monkey exact/full identity first", () => {
  const parsed = parseBeerQuery("Victory Golden Monkey");
  const ranked = rankBeerSearchHits(
    [
      hit("vault", "Victory Brewing Company", "Prima Pils", "Pilsner"),
      hit("vault", "Victory Brewing Company", "Golden Monkey", "Tripel"),
      hit("catalog_beer", "Victory Brewing Company", "HopDevil", "IPA")
    ],
    parsed
  );
  assert.equal(String(ranked[0]?.product.name), "Golden Monkey");
});

test("10. Yeungling typo still finds Yuengling Lager", () => {
  const parsed = parseBeerQuery("Yeungling Lager");
  const candidate = {
    brewery: "Yuengling",
    name: "Traditional Lager",
    style: "American Lager"
  };
  assert.equal(matchesBeerQuery(candidate, parsed), true);
  assert.equal(classifyBeerMatch(candidate, parsed), "fuzzy");
  const exact = {
    brewery: "Yuengling",
    name: "Traditional Lager",
    style: "American Lager"
  };
  const exactParsed = parseBeerQuery("Yuengling Lager");
  assert.ok(scoreBeerHit(exact, exactParsed, "vault") > scoreBeerHit(candidate, parsed, "vault"));
});

test("11. brewery-only fallback loses to full product identity", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const brawler = { brewery: "Yards", name: "Brawler", style: "English Mild" };
  const pale = { brewery: "Yards", name: "Philadelphia Pale Ale", style: "Pale Ale" };
  assert.ok(scoreBeerHit(brawler, parsed, "vault") - scoreBeerHit(pale, parsed, "vault") > 80);
});

test("12. style-only unrelated brewery does not outrank brewery+style", () => {
  const parsed = parseBeerQuery("Yards IPA");
  const yards = { brewery: "Yards", name: "India Pale Ale", style: "India Pale Ale" };
  const other = { brewery: "Unrelated Brewery", name: "House IPA", style: "IPA" };
  assert.ok(scoreBeerHit(yards, parsed, "vault") > scoreBeerHit(other, parsed, "vault"));
});

test("13. short token ipa is not fuzzy-expanded", () => {
  const parsed = parseBeerQuery("ipa");
  assert.deepEqual(parsed.styleConcepts, ["ipa"]);
  assert.deepEqual(parsed.nonStyleTokens, []);
  assert.equal(damerauLevenshtein("ipa", "ipa"), 0);
  // Matching is style-concept only — no fuzzy distance expansion of "ipa".
  assert.equal(matchesBeerQuery({ brewery: "X", name: "Pale", style: "Pale Ale" }, parsed), false);
  assert.equal(matchesBeerQuery({ brewery: "X", name: "House IPA", style: "IPA" }, parsed), true);
});

test("14. numeric tokens stay exact — 60 does not match 90", () => {
  const parsed = parseBeerQuery("60 Minute IPA");
  assert.equal(
    matchesBeerQuery({ brewery: "Dogfish Head", name: "90 Minute IPA", style: "IPA" }, parsed),
    false
  );
  assert.equal(
    matchesBeerQuery({ brewery: "Dogfish Head", name: "60 Minute IPA", style: "IPA" }, parsed),
    true
  );
});

test("15. Double IPA matches Imperial IPA style concept", () => {
  const parsed = parseBeerQuery("Double IPA");
  assert.deepEqual(parsed.styleConcepts, ["dipa"]);
  assert.equal(
    matchesBeerQuery({ brewery: "Local", name: "Bomber", style: "Imperial IPA" }, parsed),
    true
  );
});

test("16. Pils matches Pilsner style concept", () => {
  const parsed = parseBeerQuery("Pils");
  assert.deepEqual(parsed.styleConcepts, ["pilsner"]);
  assert.equal(
    matchesBeerQuery({ brewery: "Victory", name: "Prima Pils", style: "Pilsner" }, parsed),
    true
  );
});

test("R1. PR99 local sufficiency gate still skips Catalog.beer", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  for (let i = 0; i < LOCAL_BEER_SUFFICIENCY_THRESHOLD; i += 1) {
    db.prepare(
      "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
    ).run(`Local Brewery ${i}`, `Local IPA ${i}`, "IPA", 6);
  }
  let catalogCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("catalog.beer")) catalogCalls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const { results } = await searchBottles("Local IPA", { table: "packaged_beer" });
    assert.ok(results.length >= LOCAL_BEER_SUFFICIENCY_THRESHOLD);
    assert.equal(catalogCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM packaged_beer WHERE brewery LIKE 'Local Brewery %'").run();
  }
});

test("R2. PR99 Catalog.beer query cache still avoids a second remote call", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    remoteCalls += 1;
    return new Response(
      JSON.stringify({ data: [{ id: "c1", name: "Cached IPA", style: "IPA", brewer: { name: "Cache Brewery" } }] }),
      { status: 200 }
    );
  }) as typeof fetch;
  try {
    await searchCatalogBeers("troegs perpetual", 8);
    const afterFirst = getCatalogBeerUsage().requests;
    await searchCatalogBeers("  Troegs   Perpetual ", 8);
    assert.equal(remoteCalls, 1);
    assert.equal(getCatalogBeerUsage().requests, afterFirst);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("R3. style aliases do not fan out extra Catalog.beer requests", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  let catalogCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("catalog.beer")) catalogCalls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("Yards IPA", { table: "packaged_beer" });
    assert.equal(catalogCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("R4. spirit search path is unchanged by beer semantics", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let catalogCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("catalog.beer")) catalogCalls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("bourbon", { table: "spirits" });
    await searchBottles("cabernet", { table: "wines" });
    assert.equal(catalogCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
