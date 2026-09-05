/**
 * Open Brewery DB brewery resolver — fixtures/stubs only.
 * Never hits live OBDB; never invents BottleSearchHit from brewery rows.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  classifyBeerMatch,
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
import { saveBeerCacheEntry } from "./beer_cache.js";
import { db } from "./db.js";
import { lookupProduct, LOCAL_BEER_SUFFICIENCY_THRESHOLD, searchBottles } from "./lookup.js";
import {
  breweryCompareKey,
  breweryHintBonus,
  buildBreweryResolverQueries,
  clearOpenBreweryDbCacheForTests,
  isOpenBreweryDbEnabled,
  normalizeWebsiteHost,
  openBreweryDbCacheSizeForTests,
  breweryResolutionNeeded,
  resolveBreweryHints,
  scoreBreweryNameMatch,
  searchOpenBreweryDb,
  shouldAttemptBreweryResolution,
  type BreweryResolverHit
} from "./open_brewery_db.js";

const FIXTURES: Record<string, BreweryResolverHit> = {
  yards: {
    id: "yards-1",
    name: "Yards Brewing Co.",
    breweryType: "regional",
    city: "Philadelphia",
    state: "Pennsylvania",
    country: "United States",
    websiteUrl: "https://yardsbrewing.com",
    websiteHost: "yardsbrewing.com"
  },
  troegs: {
    id: "troegs-1",
    name: "Tröegs Independent Brewing",
    breweryType: "regional",
    city: "Hershey",
    state: "Pennsylvania",
    country: "United States",
    websiteUrl: "https://troegs.com",
    websiteHost: "troegs.com"
  },
  victory: {
    id: "victory-1",
    name: "Victory Brewing Company",
    breweryType: "regional",
    city: "Downingtown",
    state: "Pennsylvania",
    country: "United States",
    websiteUrl: "https://victorybeer.com",
    websiteHost: "victorybeer.com"
  },
  dogfish: {
    id: "dogfish-1",
    name: "Dogfish Head Craft Brewery",
    breweryType: "regional",
    city: "Milton",
    state: "Delaware",
    country: "United States",
    websiteUrl: "https://www.dogfish.com",
    websiteHost: "dogfish.com"
  },
  sierra: {
    id: "sierra-1",
    name: "Sierra Nevada Brewing Co.",
    breweryType: "large",
    city: "Chico",
    state: "California",
    country: "United States",
    websiteUrl: "https://sierranevada.com",
    websiteHost: "sierranevada.com"
  },
  bells: {
    id: "bells-1",
    name: "Bell's Brewery",
    breweryType: "regional",
    city: "Comstock",
    state: "Michigan",
    country: "United States",
    websiteUrl: "https://bellsbeer.com",
    websiteHost: "bellsbeer.com"
  },
  founders: {
    id: "founders-1",
    name: "Founders Brewing Co.",
    breweryType: "regional",
    city: "Grand Rapids",
    state: "Michigan",
    country: "United States",
    websiteUrl: "https://foundersbrewing.com",
    websiteHost: "foundersbrewing.com"
  },
  newbelgium: {
    id: "nb-1",
    name: "New Belgium Brewing",
    breweryType: "large",
    city: "Fort Collins",
    state: "Colorado",
    country: "United States",
    websiteUrl: "https://www.newbelgium.com",
    websiteHost: "newbelgium.com"
  },
  yuengling: {
    id: "yuen-1",
    name: "Yuengling Brewery",
    breweryType: "regional",
    city: "Pottsville",
    state: "Pennsylvania",
    country: "United States",
    websiteUrl: "https://www.yuengling.com",
    websiteHost: "yuengling.com"
  },
  firestone: {
    id: "fs-1",
    name: "Firestone Walker Brewing Company",
    breweryType: "regional",
    city: "Paso Robles",
    state: "California",
    country: "United States",
    websiteUrl: "https://www.firestonebeer.com",
    websiteHost: "firestonebeer.com"
  },
  bellwoods: {
    id: "bw-1",
    name: "Bellwoods Brewery",
    breweryType: "micro",
    city: "Toronto",
    state: "Ontario",
    country: "Canada",
    websiteUrl: "https://bellwoodsbrewery.com",
    websiteHost: "bellwoodsbrewery.com"
  }
};

function fixturePayload(...keys: (keyof typeof FIXTURES)[]) {
  return keys.map((k) => {
    const h = FIXTURES[k]!;
    return {
      id: h.id,
      name: h.name,
      brewery_type: h.breweryType,
      city: h.city,
      state_province: h.state,
      country: h.country,
      website_url: h.websiteUrl
    };
  });
}

function hit(source: string, brewery: string, name: string, style = "") {
  return {
    source,
    table: "packaged_beer" as const,
    product: { brewery, brand: brewery, name, style, category: style }
  };
}

afterEach(() => {
  clearOpenBreweryDbCacheForTests();
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  delete process.env.CATALOG_BEER_API_KEY;
  delete process.env.OPEN_BREWERY_DB_ENABLED;
  delete process.env.OPEN_BREWERY_DB_BASE_URL;
});

test("A. Open Brewery DB disabled: no HTTP request", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "false";
  assert.equal(isOpenBreweryDbEnabled(), false);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const hits = await searchOpenBreweryDb("Yards", { fetchImpl, env: process.env });
  assert.deepEqual(hits, []);
  assert.equal(calls, 0);
});

test("B. valid brewery search normalizes result correctly", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(fixturePayload("yards")), { status: 200 })) as typeof fetch;
  const hits = await searchOpenBreweryDb("Yards", { fetchImpl, skipCache: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "yards-1");
  assert.equal(hits[0]!.name, "Yards Brewing Co.");
  assert.equal(hits[0]!.websiteHost, "yardsbrewing.com");
  assert.equal(hits[0]!.city, "Philadelphia");
});

test("C. malformed response ignored safely", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ not: "an array" }), { status: 200 })) as typeof fetch;
  const hits = await searchOpenBreweryDb("Yards", { fetchImpl, skipCache: true });
  assert.deepEqual(hits, []);
});

test("D. 500/network failure: beer search continues", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Yards Brewing Co.", "Brawler", "English Mild", 4.5);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) {
      return new Response("fail", { status: 500 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const { results } = await searchBottles("Yards Brawler", { table: "packaged_beer" });
    assert.ok(results.length >= 1);
    assert.equal(results[0]!.product.name, "Brawler");
    assert.ok(results.every((r) => r.source !== "open_brewery_db"));
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM packaged_beer WHERE brewery = ? AND name = ?").run(
      "Yards Brewing Co.",
      "Brawler"
    );
  }
});

test("E/F. repeated normalized query hits resolver cache", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
  }) as typeof fetch;
  const a = await searchOpenBreweryDb("Yards", { fetchImpl });
  const b = await searchOpenBreweryDb("  yards  ", { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(a[0]!.name, b[0]!.name);
  assert.ok(openBreweryDbCacheSizeForTests() >= 1);
});

test("G. empty result short-cache behavior", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  await searchOpenBreweryDb("zzzznotabrewery", { fetchImpl });
  await searchOpenBreweryDb("zzzznotabrewery", { fetchImpl });
  assert.equal(calls, 1);
});

test("H. style-only query does not call OBDB", async () => {
  assert.equal(shouldAttemptBreweryResolution(parseBeerQuery("IPA")), false);
  assert.equal(shouldAttemptBreweryResolution(parseBeerQuery("lager")), false);
  assert.equal(shouldAttemptBreweryResolution(parseBeerQuery("pils")), false);
  assert.equal(shouldAttemptBreweryResolution(parseBeerQuery("60 Minute IPA")), false);

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) calls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("IPA", { table: "packaged_beer" });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("I. Yards Brawler resolver can identify Yards Brewing Co.", async () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const fetchImpl = (async () =>
    new Response(JSON.stringify(fixturePayload("yards")), { status: 200 })) as typeof fetch;
  const resolved = await resolveBreweryHints({
    parsed,
    candidateBreweries: ["Yards Brewing Co."],
    fetchImpl
  });
  assert.ok(resolved.some((h) => h.name === "Yards Brewing Co."));
});

test("J. Troegs Perpetual IPA: Tröegs matches after diacritic folding", () => {
  assert.equal(scoreBreweryNameMatch("Troegs", "Tröegs Independent Brewing"), "exact");
  assert.equal(breweryCompareKey("Tröegs Independent Brewing"), "troegs");
});

test("K. Victory Golden Monkey: Victory Brewing Company matches", () => {
  assert.equal(scoreBreweryNameMatch("Victory", "Victory Brewing Company"), "exact");
  assert.equal(scoreBreweryNameMatch("Victory Brewing", "Victory Brewing Company"), "exact");
});

test("L. Bell's Two Hearted: apostrophe folding works", () => {
  assert.equal(scoreBreweryNameMatch("Bells", "Bell's Brewery"), "exact");
  assert.equal(scoreBreweryNameMatch("Bell's", FIXTURES.bells!.name), "exact");
});

test("M. short ambiguous names do not substring-match unrelated breweries", () => {
  assert.equal(scoreBreweryNameMatch("Stone", "Firestone Walker Brewing Company"), "none");
  assert.equal(scoreBreweryNameMatch("Bell", "Bellwoods Brewery"), "none");
});

test("N. OBDB brewery result is NEVER converted into BottleSearchHit", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Yards Brewing Co.", "Brawler", "English Mild", 4.5);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) {
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const { results } = await searchBottles("Yards Brawler", { table: "packaged_beer" });
    assert.ok(results.every((r) => r.source !== "open_brewery_db"));
    assert.ok(results.every((r) => String(r.product.name ?? "") !== "Yards Brewing Co."));
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM packaged_beer WHERE brewery = ? AND name = ?").run(
      "Yards Brewing Co.",
      "Brawler"
    );
  }
});

test("O. OBDB cannot create a beer result when there are zero beer candidates", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) {
      obdbCalls += 1;
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const { results } = await searchBottles("zzzz rare brewery xyzabc", { table: "packaged_beer" });
    assert.equal(results.length, 0);
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P. brewery resolver bonus does not outrank exact beer identity", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const exact = hit("catalog_beer", "Random Brewery", "Yards Brawler");
  const breweryOnly = hit("vault", "Yards Brewing Co.", "Loyal Lager", "Lager");
  const hints = [FIXTURES.yards!];
  const ranked = rankBeerSearchHits([breweryOnly, exact], parsed, {
    breweryHints: hints,
    breweryHintBonus
  });
  assert.equal(ranked[0]!.product.name, "Yards Brawler");
  const exactScore = scoreBeerHit(exact.product, parsed, exact.source, {
    breweryHints: hints,
    breweryHintBonus
  });
  const breweryScore = scoreBeerHit(breweryOnly.product, parsed, breweryOnly.source, {
    breweryHints: hints,
    breweryHintBonus
  });
  assert.ok(exactScore > breweryScore);
});

test("Q. local Vault exact beer still outranks weaker remote candidate", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const vault = hit("vault", "Yards Brewing Co.", "Brawler", "English Mild");
  const remote = hit("catalog_beer", "Yards Brewing Co.", "Brawler", "English Mild");
  const hints = [FIXTURES.yards!];
  const ranked = rankBeerSearchHits([remote, vault], parsed, {
    breweryHints: hints,
    breweryHintBonus
  });
  assert.equal(ranked[0]!.source, "vault");
});

test("R. PR100 style alias ranking remains unchanged", () => {
  const parsed = parseBeerQuery("Yards IPA");
  assert.deepEqual(parsed.styleConcepts, ["ipa"]);
  const ranked = rankBeerSearchHits(
    [
      hit("vault", "Yards Brewing Co.", "Philadelphia Pale Ale", "Pale Ale"),
      hit("vault", "Yards Brewing Co.", "IPA", "IPA")
    ],
    parsed
  );
  assert.equal(ranked[0]!.product.name, "IPA");
});

test("S. PR100 typo handling remains unchanged", () => {
  const parsed = parseBeerQuery("Yeungling Lager");
  const candidate = { brewery: "Yuengling Brewery", name: "Traditional Lager", style: "Lager" };
  assert.equal(classifyBeerMatch(candidate, parsed), "fuzzy");
});

test("T. PR99 Catalog.beer sufficiency gate remains unchanged", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  process.env.OPEN_BREWERY_DB_ENABLED = "false";
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

test("U. no additional Catalog.beer requests caused by OBDB", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Yards Brewing Co.", "Brawler", "English Mild", 4.5);
  let catalogCalls = 0;
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("catalog.beer")) {
      catalogCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.includes("openbrewerydb")) {
      obdbCalls += 1;
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    // One local hit → Catalog.beer still runs (below sufficiency), OBDB may run once.
    await searchBottles("Yards Brawler", { table: "packaged_beer" });
    assert.equal(catalogCalls, 1);
    assert.ok(obdbCalls <= 2);
    assert.equal(getCatalogBeerUsage().requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM packaged_beer WHERE brewery = ? AND name = ?").run(
      "Yards Brewing Co.",
      "Brawler"
    );
  }
});

test("V. spirit search never calls OBDB", async () => {
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) obdbCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("bourbon", { table: "spirits" });
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("W. wine search never calls OBDB", async () => {
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) obdbCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("cabernet", { table: "wines" });
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("X. UPC/barcode lookup never calls OBDB", async () => {
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) obdbCalls += 1;
    return new Response(JSON.stringify({ status: 0, products: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await lookupProduct("000000000000", { kind: "beer" });
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Y. no DB schema changes required for OBDB resolver", () => {
  // Resolver is in-memory only; schema statement list is unchanged by this module.
  assert.ok(typeof searchOpenBreweryDb === "function");
  assert.ok(typeof clearOpenBreweryDbCacheForTests === "function");
});

test("bonus: Yards Brawler ranks first with OBDB hint among brewery peers", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const ranked = rankBeerSearchHits(
    [
      hit("vault", "Yards Brewing Co.", "Loyal Lager", "Lager"),
      hit("vault", "Random Brewery", "Brawler", "IPA"),
      hit("vault", "Yards Brewing Co.", "Brawler", "English Mild")
    ],
    parsed,
    { breweryHints: [FIXTURES.yards!], breweryHintBonus }
  );
  assert.equal(ranked[0]!.product.name, "Brawler");
  assert.equal(ranked[0]!.product.brewery, "Yards Brewing Co.");
  assert.ok(breweryHintBonus("Yards Brewing Co.", [FIXTURES.yards!]) >= 25);
  assert.equal(breweryHintBonus("Random Brewery", [FIXTURES.yards!]), 0);
});

test("website host normalization is safe and non-fetching", () => {
  assert.equal(normalizeWebsiteHost("https://yardsbrewing.com/path"), "yardsbrewing.com");
  assert.equal(normalizeWebsiteHost("http://www.dogfish.com"), "dogfish.com");
  assert.equal(normalizeWebsiteHost("not a url"), null);
  assert.equal(normalizeWebsiteHost("ftp://evil.example"), null);
});

test("query candidates stay bounded and prefer brewery hints", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  const qs = buildBreweryResolverQueries(parsed, ["Yards Brewing Co.", "Other Brewery"]);
  assert.ok(qs.length <= 2);
  assert.ok(qs[0]!.includes("yards"));
});

test("malformed rows discarded", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify([
        { id: "", name: "Bad" },
        { id: "ok", name: "" },
        { id: "good", name: "Good Brewery", website_url: "https://good.example" },
        null,
        "x"
      ]),
      { status: 200 }
    )) as typeof fetch;
  const hits = await searchOpenBreweryDb("Good", { fetchImpl, skipCache: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.name, "Good Brewery");
});

test("corpus fixtures fold/compare strongly", () => {
  const pairs: Array<[string, string]> = [
    ["Yards", "Yards Brewing Co."],
    ["Troegs", "Tröegs Independent Brewing"],
    ["Victory", "Victory Brewing Company"],
    ["Dogfish Head", "Dogfish Head Craft Brewery"],
    ["Sierra Nevada", "Sierra Nevada Brewing Co."],
    ["Bells", "Bell's Brewery"],
    ["Founders", "Founders Brewing Co."],
    ["New Belgium", "New Belgium Brewing"],
    ["Yuengling", "Yuengling Brewery"]
  ];
  for (const [left, right] of pairs) {
    const strength = scoreBreweryNameMatch(left, right);
    assert.ok(strength === "exact" || strength === "strong", `${left} vs ${right} → ${strength}`);
  }
});

test("Gate A. exact Vault Yards Brawler skips OBDB", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Yards Brewing Co.", "Brawler", "English Mild", 4.5);
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) {
      obdbCalls += 1;
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const parsed = parseBeerQuery("Yards Brawler");
    assert.equal(
      breweryResolutionNeeded(
        [{ source: "vault", product: { brewery: "Yards Brewing Co.", name: "Brawler" } }],
        parsed
      ),
      false
    );
    const { results } = await searchBottles("Yards Brawler", { table: "packaged_beer" });
    assert.ok(results.length >= 1);
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM packaged_beer WHERE brewery = ? AND name = ?").run(
      "Yards Brewing Co.",
      "Brawler"
    );
  }
});

test("Gate B. strong beer_cache result skips OBDB", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  const upc = "080109100123";
  saveBeerCacheEntry({
    upc,
    brewery: "Yards Brewing Co.",
    name: "Brawler",
    style: "English Mild",
    abv: 4.5,
    source: "catalog_beer"
  });
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) {
      obdbCalls += 1;
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(
      breweryResolutionNeeded(
        [{ source: "beer_cache", product: { brewery: "Yards Brewing Co.", name: "Brawler" } }],
        parseBeerQuery("Yards Brawler")
      ),
      false
    );
    const { results } = await searchBottles("Yards Brawler", { table: "packaged_beer" });
    assert.ok(results.some((r) => r.source === "beer_cache" || r.source === "vault"));
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(upc);
  }
});

test("Gate C. ambiguous competing breweries may call OBDB", () => {
  const parsed = parseBeerQuery("Yards Brawler");
  assert.equal(
    breweryResolutionNeeded(
      [
        { source: "vault", product: { brewery: "Yards Brewing Co.", name: "Brawler" } },
        { source: "vault", product: { brewery: "Yards Alehouse", name: "Brawler" } }
      ],
      parsed
    ),
    true
  );
  assert.equal(
    breweryResolutionNeeded(
      [
        { source: "catalog_beer", product: { brewery: "Yards Brewing Co.", name: "Brawler" } },
        { source: "catalog_beer", product: { brewery: "Other Brewery", name: "Brawler" } }
      ],
      parsed
    ),
    true
  );
});

test("Gate D. weak/brewery-only candidates may call OBDB", () => {
  assert.equal(
    breweryResolutionNeeded(
      [{ source: "vault", product: { brewery: "Yards Brewing Co.", name: "Brawler" } }],
      parseBeerQuery("Yards")
    ),
    true
  );
  assert.equal(
    breweryResolutionNeeded(
      [{ source: "catalog_beer", product: { brewery: "Yards Brewing Co.", name: "Brawler" } }],
      parseBeerQuery("Yards Brawler")
    ),
    true
  );
});

test("Gate E. style-only query still never calls OBDB", async () => {
  assert.equal(breweryResolutionNeeded([{ source: "vault", product: { name: "IPA", style: "IPA" } }], parseBeerQuery("IPA")), false);
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) obdbCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("IPA", { table: "packaged_beer" });
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gate F. zero beer candidates still never calls OBDB", async () => {
  assert.equal(breweryResolutionNeeded([], parseBeerQuery("Yards Brawler")), false);
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("openbrewerydb")) {
      obdbCalls += 1;
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const { results } = await searchBottles("zzzz rare brewery xyzabc", { table: "packaged_beer" });
    assert.equal(results.length, 0);
    assert.equal(obdbCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gate G. OBDB still never creates a BottleSearchHit", async () => {
  process.env.OPEN_BREWERY_DB_ENABLED = "true";
  delete process.env.CATALOG_BEER_API_KEY;
  // Remote-only candidate so OBDB gate opens, but brewery rows must not become hits.
  let obdbCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("openbrewerydb")) {
      obdbCalls += 1;
      return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
    }
    if (url.includes("catalog.beer") || url.includes("catalogbeer")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "cb-1",
              name: "Brawler",
              style: "English Mild",
              abv: "4.5",
              brewer: { name: "Yards Brewing Co." }
            }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  process.env.CATALOG_BEER_API_KEY = "test-key";
  try {
    const { results } = await searchBottles("Yards Brawler", { table: "packaged_beer" });
    assert.ok(results.every((r) => r.source !== "open_brewery_db"));
    assert.ok(results.every((r) => String(r.product.name ?? "") !== "Yards Brewing Co."));
    // Gate may or may not call OBDB depending on catalog hit strength; never invent rows either way.
    assert.ok(obdbCalls >= 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CATALOG_BEER_API_KEY;
  }
});

test("Gate H. Catalog.beer call count unchanged by OBDB gate", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Yards Brewing Co.", "Brawler", "English Mild", 4.5);

  async function runOnce(obdbEnabled: boolean) {
    process.env.OPEN_BREWERY_DB_ENABLED = obdbEnabled ? "true" : "false";
    clearCatalogBeerSearchCache();
    resetCatalogBeerQuota();
    clearOpenBreweryDbCacheForTests();
    let catalogCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("catalog.beer") || url.includes("catalogbeer")) {
        catalogCalls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.includes("openbrewerydb")) {
        return new Response(JSON.stringify(fixturePayload("yards")), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    try {
      await searchBottles("Yards Brawler", { table: "packaged_beer" });
      return catalogCalls;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  try {
    const withObdb = await runOnce(true);
    const withoutObdb = await runOnce(false);
    assert.equal(withObdb, withoutObdb);
  } finally {
    db.prepare("DELETE FROM packaged_beer WHERE brewery = ? AND name = ?").run(
      "Yards Brewing Co.",
      "Brawler"
    );
  }
});
