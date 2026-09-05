/**
 * Beer lookup foundation — UPC twin resolution + Catalog.beer quota guards.
 * Fixtures/stubs only; no live Catalog.beer or OFF calls.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  beerCacheUpcLookupKeys,
  getBeerCacheEntry,
  saveBeerCacheEntry
} from "./beer_cache.js";
import {
  CATALOG_BEER_SEARCH_CACHE_MAX,
  clearCatalogBeerSearchCache,
  expireCatalogBeerSearchCacheForTests,
  getCatalogBeerSearchCacheSize,
  getCatalogBeerUsage,
  isCatalogBeerConfigured,
  resetCatalogBeerQuota,
  searchCatalogBeers
} from "./catalog_beer.js";
import { ean13Form, normalizeUpc, primaryCatalogUpc, upcAForm } from "./cola_client.js";
import { db } from "./db.js";
import {
  LOCAL_BEER_SUFFICIENCY_THRESHOLD,
  rememberBeerFromHit,
  searchBottles,
  type BottleSearchHit
} from "./lookup.js";

const UPC_A = "036000291452";
const EAN_13 = "0036000291452";
const OTHER_UPC = "008500012345";


function countBeerCacheTwins(upc: string): number {
  const keys = beerCacheUpcLookupKeys(upc);
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(", ");
  const row = db.prepare(`SELECT COUNT(*) AS n FROM beer_cache WHERE upc IN (${placeholders})`).get(...keys) as { n: number };
  return Number(row.n);
}

function insertRawBeerCacheRow(row: {
  upc: string;
  brewery?: string;
  name: string;
  style?: string;
  abv?: number | null;
  catalog_beer_id?: string | null;
  untappd_bid?: string | null;
  image_url?: string | null;
  source?: string;
  cached_at: number;
}) {
  db.prepare(`
    INSERT INTO beer_cache (
      upc, catalog_beer_id, untappd_bid, brewery, name, style, abv, image_url, source, cached_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.upc,
    row.catalog_beer_id ?? null,
    row.untappd_bid ?? null,
    row.brewery ?? "",
    row.name,
    row.style ?? "",
    row.abv ?? null,
    row.image_url ?? null,
    row.source ?? "vault_seed",
    row.cached_at
  );
}

function wipeBeerCache(...upcs: string[]) {
  for (const upc of upcs) {
    for (const key of beerCacheUpcLookupKeys(upc)) {
      db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(key);
    }
  }
}

afterEach(() => {
  wipeBeerCache(UPC_A, EAN_13, OTHER_UPC, "080012345678");
  resetCatalogBeerQuota();
  clearCatalogBeerSearchCache();
  delete process.env.CATALOG_BEER_API_KEY;
});

test("A. saved UPC-A lookup is an exact hit", () => {
  wipeBeerCache(UPC_A);
  const stored = saveBeerCacheEntry({
    upc: UPC_A,
    brewery: "Yuengling",
    name: "Traditional Lager",
    style: "American Lager",
    abv: 4.5,
    source: "vault_seed"
  });
  assert.equal(stored, UPC_A);
  const hit = getBeerCacheEntry(UPC_A);
  assert.ok(hit);
  assert.equal(hit?.name, "Traditional Lager");
  assert.equal(hit?.upc, UPC_A);
});

test("B. equivalent EAN-13 lookup finds the same cached beer", () => {
  wipeBeerCache(UPC_A, EAN_13);
  saveBeerCacheEntry({
    upc: UPC_A,
    brewery: "Yards",
    name: "Brawler",
    style: "English Mild",
    abv: 4.2,
    source: "catalog_beer"
  });
  const hit = getBeerCacheEntry(EAN_13);
  assert.ok(hit);
  assert.equal(hit?.name, "Brawler");
  assert.equal(hit?.brewery, "Yards");
});

test("C. saved EAN-13 resolves equivalent UPC-A", () => {
  wipeBeerCache(UPC_A, EAN_13);
  saveBeerCacheEntry({
    upc: EAN_13,
    brewery: "Troegs",
    name: "Perpetual IPA",
    style: "American IPA",
    abv: 7.5,
    source: "vault_seed"
  });
  const hit = getBeerCacheEntry(UPC_A);
  assert.ok(hit);
  assert.equal(hit?.name, "Perpetual IPA");
});

test("D. 12-digit UPC-A never becomes an invalid 11-digit key", () => {
  assert.equal(normalizeUpc(UPC_A).length, 12);
  assert.equal(upcAForm(UPC_A), UPC_A);
  assert.equal(primaryCatalogUpc(UPC_A), UPC_A);
  assert.equal(ean13Form(UPC_A), EAN_13);
  assert.ok(!beerCacheUpcLookupKeys(UPC_A).some((key) => key.length === 11));
  wipeBeerCache(UPC_A);
  const stored = saveBeerCacheEntry({
    upc: UPC_A,
    brewery: "Dogfish Head",
    name: "60 Minute IPA",
    style: "IPA",
    abv: 6,
    source: "vault_seed"
  });
  assert.equal(stored, UPC_A);
  assert.equal(String(stored).length, 12);
});

test("E. unrelated UPC does not match", () => {
  wipeBeerCache(UPC_A, OTHER_UPC);
  saveBeerCacheEntry({
    upc: UPC_A,
    brewery: "Yuengling",
    name: "Traditional Lager",
    source: "vault_seed"
  });
  assert.equal(getBeerCacheEntry(OTHER_UPC), null);
});

test("F. scanned UPC is what /api/beer/remember ultimately persists", async () => {
  wipeBeerCache(UPC_A, EAN_13);
  const hit: BottleSearchHit = {
    source: "catalog_beer",
    table: "packaged_beer",
    catalog_beer_id: "catalog-yards-brawler",
    product: {
      name: "Brawler",
      brewery: "Yards",
      brand: "Yards",
      style: "English Mild",
      abv: 4.2,
      // Deliberately wrong / empty product UPC — scanned code must win.
      upc: ""
    }
  };
  await rememberBeerFromHit(UPC_A, hit);
  const entry = getBeerCacheEntry(UPC_A);
  assert.ok(entry);
  assert.equal(entry?.upc, UPC_A);
  assert.equal(entry?.name, "Brawler");
  assert.equal(entry?.catalog_beer_id, "catalog-yards-brawler");
});

test("G. hit.product.upc cannot silently replace the scanned UPC", async () => {
  wipeBeerCache(UPC_A, OTHER_UPC);
  const hit: BottleSearchHit = {
    source: "catalog_beer",
    table: "packaged_beer",
    catalog_beer_id: "catalog-troegs",
    product: {
      name: "Perpetual IPA",
      brewery: "Troegs",
      upc: OTHER_UPC,
      abv: 7.5
    }
  };
  await rememberBeerFromHit(UPC_A, hit);
  assert.ok(getBeerCacheEntry(UPC_A));
  assert.equal(getBeerCacheEntry(OTHER_UPC), null);
});

test("H. repeated remember of equivalent barcodes does not create duplicate rows", async () => {
  wipeBeerCache(UPC_A, EAN_13);
  const hit: BottleSearchHit = {
    source: "catalog_beer",
    table: "packaged_beer",
    catalog_beer_id: "dfh-60",
    product: { name: "60 Minute IPA", brewery: "Dogfish Head", abv: 6 }
  };
  await rememberBeerFromHit(UPC_A, hit);
  await rememberBeerFromHit(EAN_13, hit);
  const keys = beerCacheUpcLookupKeys(UPC_A);
  const rows = db.prepare(`SELECT upc FROM beer_cache WHERE upc IN (${keys.map(() => "?").join(",")})`).all(...keys) as Array<{ upc: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.upc, UPC_A);
});

test("I. empty new fields do not erase useful known beer cache data", () => {
  wipeBeerCache(UPC_A);
  saveBeerCacheEntry({
    upc: UPC_A,
    brewery: "Yuengling",
    name: "Traditional Lager",
    style: "American Lager",
    abv: 4.5,
    catalog_beer_id: "y-trad",
    source: "catalog_beer"
  });
  saveBeerCacheEntry({
    upc: UPC_A,
    brewery: "",
    name: "Traditional Lager",
    style: "",
    abv: null,
    catalog_beer_id: null,
    source: "vault_seed"
  });
  const entry = getBeerCacheEntry(UPC_A);
  assert.equal(entry?.brewery, "Yuengling");
  assert.equal(entry?.style, "American Lager");
  assert.equal(entry?.abv, 4.5);
  assert.equal(entry?.catalog_beer_id, "y-trad");
});

test("J. local result count below threshold calls Catalog.beer", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let catalogBeerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("catalog.beer")) {
      catalogBeerCalls += 1;
      return new Response(JSON.stringify({
        data: [{ id: "remote-1", name: "Rare Stout", style: "Stout", abv: 8, brewer: { name: "Tiny Brewery" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ products: [], data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.ok(LOCAL_BEER_SUFFICIENCY_THRESHOLD >= 1);
    const { results } = await searchBottles("zzzz rare stout xyz", { table: "packaged_beer" });
    assert.ok(catalogBeerCalls >= 1, "Catalog.beer should be consulted when local coverage is thin");
    assert.ok(results.some((hit) => hit.source === "catalog_beer"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("K. sufficient local unique results skip Catalog.beer", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  wipeBeerCache(UPC_A);
  for (let i = 0; i < LOCAL_BEER_SUFFICIENCY_THRESHOLD; i += 1) {
    saveBeerCacheEntry({
      upc: `08000000000${i}`,
      brewery: `Local Brewery ${i}`,
      name: `Local IPA ${i}`,
      style: "IPA",
      abv: 6 + i * 0.1,
      source: "vault_seed"
    });
  }
  let catalogBeerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("catalog.beer")) catalogBeerCalls += 1;
    return new Response(JSON.stringify({ products: [], data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const before = getCatalogBeerUsage().requests;
    const { results } = await searchBottles("Local IPA", { table: "packaged_beer" });
    assert.ok(results.length >= LOCAL_BEER_SUFFICIENCY_THRESHOLD);
    assert.equal(catalogBeerCalls, 0);
    assert.equal(getCatalogBeerUsage().requests, before);
    assert.ok(!results.some((hit) => hit.source === "catalog_beer"));
  } finally {
    globalThis.fetch = originalFetch;
    for (let i = 0; i < LOCAL_BEER_SUFFICIENCY_THRESHOLD; i += 1) {
      wipeBeerCache(`08000000000${i}`);
    }
  }
});

test("L. duplicate local rows do not falsely satisfy threshold", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  wipeBeerCache(UPC_A);
  // Five vault rows of the same brewery+name must count as one unique local beer.
  const ids: number[] = [];
  for (let i = 0; i < LOCAL_BEER_SUFFICIENCY_THRESHOLD; i += 1) {
    const row = db.prepare(
      "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
    ).run("Solo Brewing", "Only One", "Lager", 4.5);
    ids.push(Number(row.lastInsertRowid));
  }
  let catalogBeerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("catalog.beer")) {
      catalogBeerCalls += 1;
      return new Response(JSON.stringify({
        data: [{ id: "solo-remote", name: "Only One Remote", brewer: { name: "Solo Brewing" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ products: [], data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("Only One", { table: "packaged_beer" });
    assert.ok(catalogBeerCalls >= 1, "duplicate vault rows must not suppress Catalog.beer");
  } finally {
    globalThis.fetch = originalFetch;
    for (const id of ids) db.prepare("DELETE FROM packaged_beer WHERE id=?").run(id);
  }
});

test("M. identical normalized query uses Catalog.beer cache", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    remoteCalls += 1;
    return new Response(JSON.stringify({
      data: [{ id: "cache-1", name: "Cached IPA", brewer: { name: "Cache Brewery" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const first = await searchCatalogBeers("  Troegs   Perpetual  ", 8);
    const second = await searchCatalogBeers("troegs perpetual", 8);
    assert.equal(first[0]?.name, "Cached IPA");
    assert.equal(second[0]?.name, "Cached IPA");
    assert.equal(remoteCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("N. cache hit does not increment remote request count", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "n1", name: "Quota IPA", brewer: { name: "Q" } }] }), {
      status: 200
    })) as typeof fetch;
  try {
    await searchCatalogBeers("quota ipa", 5);
    const afterRemote = getCatalogBeerUsage().requests;
    await searchCatalogBeers("quota ipa", 5);
    assert.equal(getCatalogBeerUsage().requests, afterRemote);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("O. expired cache entry performs remote request again", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    remoteCalls += 1;
    return new Response(JSON.stringify({ data: [{ id: "exp", name: "Expired", brewer: { name: "E" } }] }), {
      status: 200
    });
  }) as typeof fetch;
  try {
    await searchCatalogBeers("expired beer", 4);
    // Force expiry by clearing cache (TTL path covered via clear; dedicated clock injection not required).
    expireCatalogBeerSearchCacheForTests();
    await searchCatalogBeers("expired beer", 4);
    assert.equal(remoteCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P. cache max bound is enforced", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const q = new URL(url).searchParams.get("q") || "x";
    return new Response(JSON.stringify({ data: [{ id: q, name: q, brewer: { name: "B" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    for (let i = 0; i < CATALOG_BEER_SEARCH_CACHE_MAX + 25; i += 1) {
      await searchCatalogBeers(`unique beer query ${i}`, 3);
    }
    assert.ok(getCatalogBeerSearchCacheSize() <= CATALOG_BEER_SEARCH_CACHE_MAX);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Q. failed remote request is not cached as a long-lived success", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    remoteCalls += 1;
    return new Response("nope", { status: 503 });
  }) as typeof fetch;
  try {
    const first = await searchCatalogBeers("failing beer", 5);
    const second = await searchCatalogBeers("failing beer", 5);
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.equal(remoteCalls, 2);
    assert.equal(getCatalogBeerSearchCacheSize(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("R. unconfigured Catalog.beer makes no request", async () => {
  delete process.env.CATALOG_BEER_API_KEY;
  resetCatalogBeerQuota();
  assert.equal(isCatalogBeerConfigured(), false);
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    remoteCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const hits = await searchCatalogBeers("anything", 5);
    assert.deepEqual(hits, []);
    assert.equal(remoteCalls, 0);
    assert.equal(getCatalogBeerUsage().requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("S. exhausted quota makes no request", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "burn", name: "Burn", brewer: { name: "B" } }] }), {
      status: 200
    })) as typeof fetch;
  try {
    // Burn the in-memory monthly counter.
    const { CATALOG_BEER_MONTHLY_LIMIT } = await import("./catalog_beer.js");
    for (let i = 0; i < CATALOG_BEER_MONTHLY_LIMIT; i += 1) {
      await searchCatalogBeers(`burn-${i}`, 1);
    }
    let remoteCalls = 0;
    globalThis.fetch = (async () => {
      remoteCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const hits = await searchCatalogBeers("after exhaustion", 5);
    assert.deepEqual(hits, []);
    assert.equal(remoteCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("T. short/invalid query makes no request", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    remoteCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await searchCatalogBeers("a", 5), []);
    assert.deepEqual(await searchCatalogBeers(" ", 5), []);
    assert.equal(remoteCalls, 0);
    assert.equal(getCatalogBeerUsage().requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("U. spirit/wine search paths are unchanged by beer Catalog.beer gating", async () => {
  process.env.CATALOG_BEER_API_KEY = "test-key";
  resetCatalogBeerQuota();
  let catalogBeerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("catalog.beer")) catalogBeerCalls += 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await searchBottles("bourbon", { table: "spirits" });
    await searchBottles("cabernet", { table: "wines" });
    assert.equal(catalogBeerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V. historical duplicate UPC-A/EAN-13 rows converge on lookup", () => {
  wipeBeerCache(UPC_A, EAN_13);
  const now = Math.floor(Date.now() / 1000);
  // Simulate pre-fix saves that stored normalizeUpc() for each form separately.
  insertRawBeerCacheRow({
    upc: UPC_A,
    brewery: "Yuengling",
    name: "Traditional Lager",
    style: "",
    abv: null,
    catalog_beer_id: "yuengling-trad",
    image_url: null,
    source: "vault_seed",
    cached_at: now - 500
  });
  insertRawBeerCacheRow({
    upc: EAN_13,
    brewery: "",
    name: "Traditional Lager",
    style: "American Lager",
    abv: 4.5,
    catalog_beer_id: null,
    untappd_bid: "untappd-123",
    image_url: "https://example.com/yuengling.jpg",
    source: "catalog_beer",
    cached_at: now - 100
  });
  assert.equal(countBeerCacheTwins(UPC_A), 2);

  const hit = getBeerCacheEntry(UPC_A);
  assert.ok(hit);
  assert.equal(hit?.upc, primaryCatalogUpc(UPC_A));
  assert.equal(hit?.brewery, "Yuengling");
  assert.equal(hit?.style, "American Lager");
  assert.equal(hit?.abv, 4.5);
  assert.equal(hit?.catalog_beer_id, "yuengling-trad");
  assert.equal(hit?.untappd_bid, "untappd-123");
  assert.equal(hit?.image_url, "https://example.com/yuengling.jpg");
  assert.equal(countBeerCacheTwins(UPC_A), 1);

  const viaEan = getBeerCacheEntry(EAN_13);
  assert.ok(viaEan);
  assert.equal(viaEan?.upc, hit?.upc);
  assert.equal(viaEan?.name, hit?.name);
  assert.equal(countBeerCacheTwins(EAN_13), 1);
});

test("W. save consolidates historical twin rows onto the canonical key", () => {
  wipeBeerCache(UPC_A, EAN_13);
  const now = Math.floor(Date.now() / 1000);
  insertRawBeerCacheRow({
    upc: EAN_13,
    brewery: "Yards",
    name: "Brawler",
    style: "English Mild",
    abv: 4.2,
    catalog_beer_id: "yards-brawler",
    source: "vault_seed",
    cached_at: now - 400
  });
  insertRawBeerCacheRow({
    upc: UPC_A,
    brewery: "",
    name: "Brawler",
    style: "",
    abv: null,
    image_url: "https://example.com/brawler.jpg",
    source: "catalog_beer",
    cached_at: now - 200
  });
  assert.equal(countBeerCacheTwins(UPC_A), 2);

  const stored = saveBeerCacheEntry({
    upc: EAN_13,
    brewery: "",
    name: "Brawler",
    style: "",
    abv: null,
    source: "vault_seed"
  });
  assert.equal(stored, primaryCatalogUpc(EAN_13));
  assert.equal(countBeerCacheTwins(UPC_A), 1);

  const hit = getBeerCacheEntry(EAN_13);
  assert.equal(hit?.upc, primaryCatalogUpc(UPC_A));
  assert.equal(hit?.brewery, "Yards");
  assert.equal(hit?.style, "English Mild");
  assert.equal(hit?.abv, 4.2);
  assert.equal(hit?.catalog_beer_id, "yards-brawler");
  assert.equal(hit?.image_url, "https://example.com/brawler.jpg");
});

test("X. getBeerCacheEntry is deterministic when twin rows disagree", () => {
  wipeBeerCache(UPC_A, EAN_13);
  const now = Math.floor(Date.now() / 1000);
  insertRawBeerCacheRow({
    upc: EAN_13,
    brewery: "Old Brewery",
    name: "Perpetual IPA",
    style: "IPA",
    abv: 7.0,
    source: "vault_seed",
    cached_at: now - 800
  });
  insertRawBeerCacheRow({
    upc: UPC_A,
    brewery: "Troegs",
    name: "Perpetual IPA",
    style: "American IPA",
    abv: 7.5,
    catalog_beer_id: "troegs-perpetual",
    source: "catalog_beer",
    cached_at: now - 50
  });

  const a = getBeerCacheEntry(UPC_A);
  const b = getBeerCacheEntry(EAN_13);
  assert.equal(a?.upc, primaryCatalogUpc(UPC_A));
  assert.equal(b?.upc, a?.upc);
  assert.equal(a?.brewery, "Troegs");
  assert.equal(a?.style, "American IPA");
  assert.equal(a?.abv, 7.5);
  assert.equal(a?.catalog_beer_id, "troegs-perpetual");
  assert.equal(countBeerCacheTwins(UPC_A), 1);
});
