/**
 * Official brewery browser-fallback orchestration — stubs only.
 * Static PR103 remains first; Figranium is injected via deps.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { field, mergeField } from "./ingestion/candidate/index.js";
import type { BottleCandidate, ProductFieldSource } from "./ingestion/candidate/types.js";
import { applyOfficialBreweryBeerDiscovery } from "./ingestion/jobs/official-brewery-beer.js";
import { clearFieldOwnershipForTests, stampHumanFieldOwnership } from "./ingestion/jobs/field-ownership.js";
import {
  clearEnrichmentSourcesForTests,
  getEnrichmentSource
} from "./ingestion/jobs/enrichment-sources.js";
import type { OfficialBeerBrowserOutcome } from "./official_brewery_beer_browser.js";
import {
  clearOfficialBeerDiscoveryCache,
  discoverOfficialBeerProductPage,
  htmlLooksLikeJsAppShell,
  scoreOfficialBeerHtmlPage,
  type OfficialBeerDiscoveryDeps
} from "./official_brewery_beer_discovery.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/official-brewery-beer"
);

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

const JS_SHELL = `<!doctype html>
<html><head><title>Beers</title></head>
<body><div id="root"></div>
<script src="/assets/app.js"></script>
<script src="/assets/vendor.js"></script>
<script src="/assets/runtime.js"></script>
</body></html>`;

function shellFetch(): NonNullable<OfficialBeerDiscoveryDeps["fetchHtml"]> {
  return async (url: string) => {
    if (url.includes("sitemap")) {
      return { finalUrl: url, html: "", contentType: "text/plain" };
    }
    return { finalUrl: url, html: JS_SHELL, contentType: "text/html" };
  };
}

function yardsMatchedFetch(): NonNullable<OfficialBeerDiscoveryDeps["fetchHtml"]> {
  return async (url: string) => {
    if (url.includes("sitemap.xml") && !url.includes("index")) {
      return {
        finalUrl: url,
        html: fixture("yards-sitemap.xml"),
        contentType: "application/xml"
      };
    }
    if (url.includes("sitemap")) {
      return { finalUrl: url, html: "", contentType: "text/plain" };
    }
    if (url.includes("brawler")) {
      return {
        finalUrl: "https://yardsbrewing.com/beers/brawler",
        html: fixture("yards-brawler.html"),
        contentType: "text/html"
      };
    }
    return {
      finalUrl: url,
      html: `<html><body><a href="/beers/brawler">Brawler</a></body></html>`,
      contentType: "text/html"
    };
  };
}

function makeCandidate(source: ProductFieldSource, abv: number | null = null): BottleCandidate {
  return {
    primarySource: source,
    upc: field(null, source),
    name: field("Brawler", source),
    brand: field("Yards Brewing Co.", source),
    product_type: field("packaged_beer", source),
    category: field(null, source),
    abv: field(abv, source),
    proof: field(null, source),
    volume_ml: field(null, source),
    origin: field(null, source),
    ttb_id: field(null, source)
  };
}

function okBrowserPage(html = fixture("yards-brawler.html")): OfficialBeerBrowserOutcome {
  return {
    status: "ok",
    page: {
      finalUrl: "https://yardsbrewing.com/beers/brawler",
      title: "Brawler",
      html,
      links: []
    }
  };
}

afterEach(() => {
  clearOfficialBeerDiscoveryCache();
  clearFieldOwnershipForTests();
  clearEnrichmentSourcesForTests();
  clearFieldOwnershipForTests();
  delete process.env.FIGRANIUM_OFFICIAL_BEER_TASK_ID;
});

test("A. static exact match → browser calls = 0", async () => {
  let browserCalls = 0;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      fetchHtml: yardsMatchedFetch(),
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return { status: "unavailable", reason: "should_not_run" };
      }
    }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.equal(browserCalls, 0);
});

test("B. static unsupported_static_site → browser fallback eligible", async () => {
  let browserCalls = 0;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Troegs Independent Brewing",
      beerName: "Perpetual IPA",
      breweryWebsiteUrl: "https://troegs.com"
    },
    {
      maxPages: 2,
      fetchHtml: shellFetch(),
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return {
          status: "ok",
          page: {
            finalUrl: "https://troegs.com/beers/perpetual-ipa",
            title: "Perpetual IPA",
            html: `<html><head><title>Perpetual IPA</title></head>
<body><h1>Perpetual IPA</h1><p>ABV 7.5%</p></body></html>`,
            links: []
          }
        };
      }
    }
  );
  assert.ok(browserCalls >= 1);
  assert.equal(result.status, "matched");
  assert.ok(result.match === "exact_name" || result.match === "strong_name");
  assert.match(String(result.productPageUrl), /troegs\.com/);
  assert.equal(result.reason, "browser_matched");
});

test("C. ordinary static not_found with no JS evidence → browser calls = 0", async () => {
  let browserCalls = 0;
  const boring = `<html><head><title>Home</title></head>
<body><h1>Welcome</h1><p>${"About our brewery. ".repeat(40)}</p>
<a href="/about">About</a></body></html>`;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Does Not Exist Ale",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      maxPages: 6,
      fetchHtml: async (url) => {
        if (url.includes("sitemap.xml") && !url.includes("index")) {
          return {
            finalUrl: url,
            html: fixture("yards-sitemap.xml"),
            contentType: "application/xml"
          };
        }
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        return { finalUrl: url, html: boring, contentType: "text/html" };
      },
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return { status: "unavailable", reason: "should_not_run" };
      }
    }
  );
  assert.equal(result.status, "not_found");
  assert.equal(browserCalls, 0);
});

test("D. eligible JS-rendered miss → browser may run", async () => {
  let browserCalls = 0;
  await discoverOfficialBeerProductPage(
    {
      breweryName: "Dogfish Head",
      beerName: "60 Minute IPA",
      breweryWebsiteUrl: "https://www.dogfish.com"
    },
    {
      fetchHtml: shellFetch(),
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return { status: "unavailable", reason: "stubbed_down" };
      }
    }
  );
  assert.ok(browserCalls >= 1);
});

test("E. missing browser config → safe no-op", async () => {
  delete process.env.FIGRANIUM_OFFICIAL_BEER_TASK_ID;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: shellFetch() }
  );
  assert.ok(result.status === "unsupported_static_site" || result.status === "not_found");
});

test("F/G. Figranium timeout/error → discovery continues without match", async () => {
  for (const outcome of [
    { status: "timeout", reason: "timeout" },
    { status: "error", reason: "500" }
  ] as const) {
    clearOfficialBeerDiscoveryCache();
    const result = await discoverOfficialBeerProductPage(
      {
        breweryName: "Dogfish Head",
        beerName: "60 Minute IPA",
        breweryWebsiteUrl: "https://www.dogfish.com"
      },
      {
        fetchHtml: shellFetch(),
        browserFallbackEnabled: true,
        renderOfficialPage: async () => outcome
      }
    );
    assert.notEqual(result.status, "matched");
    assert.equal(result.match, "none");
  }
});

test("H/I. invalid / off-domain browser outcomes rejected", async () => {
  for (const outcome of [
    { status: "invalid_result", reason: "empty_render" },
    { status: "off_domain", reason: "final_url_off_domain" }
  ] as const) {
    clearOfficialBeerDiscoveryCache();
    const result = await discoverOfficialBeerProductPage(
      {
        breweryName: "Dogfish Head",
        beerName: "60 Minute IPA",
        breweryWebsiteUrl: "https://www.dogfish.com"
      },
      {
        fetchHtml: shellFetch(),
        browserFallbackEnabled: true,
        renderOfficialPage: async () => outcome
      }
    );
    assert.notEqual(result.status, "matched");
    assert.equal(result.productPageUrl, null);
  }
});

test("J. off-domain rendered page URL cannot score as official", () => {
  const scored = scoreOfficialBeerHtmlPage({
    html: fixture("yards-brawler.html"),
    pageUrl: "https://untappd.com/brawler",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    registeredDomain: "yardsbrewing.com"
  });
  assert.equal(scored, null);
});

test("K/L. rendered exact and strong beer pages match", () => {
  assert.equal(htmlLooksLikeJsAppShell(JS_SHELL), true);
  const exact = scoreOfficialBeerHtmlPage({
    html: fixture("yards-brawler.html"),
    pageUrl: "https://yardsbrewing.com/beers/brawler",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    registeredDomain: "yardsbrewing.com"
  });
  assert.ok(exact);
  assert.equal(exact!.match, "exact_name");

  const strong = scoreOfficialBeerHtmlPage({
    html: `<html><head><title>Our Beers · Golden Monkey</title></head>
<body><h1>Golden Monkey</h1><p>Belgian-style tripels from Victory Brewing.</p>
<p>ABV 9.5%</p></body></html>`,
    pageUrl: "https://www.victorybeer.com/beers/golden-monkey",
    beerName: "Golden Monkey",
    breweryName: "Victory Brewing",
    registeredDomain: "victorybeer.com"
  });
  assert.ok(strong);
  assert.ok(strong!.match === "exact_name" || strong!.match === "strong_name");
});

test("M. weak/typo-near beer page rejected for official identity", () => {
  const scored = scoreOfficialBeerHtmlPage({
    html: `<html><head><title>Brawlr</title></head>
<body><h1>Brawlr</h1><p>A brown ale.</p></body></html>`,
    pageUrl: "https://yardsbrewing.com/beers/brawlr",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    registeredDomain: "yardsbrewing.com"
  });
  assert.ok(!scored || (scored.match !== "exact_name" && scored.match !== "strong_name"));
});

test("N/O. same-domain canonical accepted; off-domain canonical ignored", () => {
  const same = scoreOfficialBeerHtmlPage({
    html: fixture("yards-brawler.html"),
    pageUrl: "https://yardsbrewing.com/beers/brawler?utm=1",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    registeredDomain: "yardsbrewing.com"
  });
  assert.equal(same?.fields.canonicalUrl, "https://yardsbrewing.com/beers/brawler");

  const offHtml = fixture("yards-brawler.html").replaceAll(
    "https://yardsbrewing.com/beers/brawler",
    "https://shop.example/brawler"
  );
  const off = scoreOfficialBeerHtmlPage({
    html: offHtml,
    pageUrl: "https://yardsbrewing.com/beers/brawler",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    registeredDomain: "yardsbrewing.com"
  });
  assert.ok(off);
  assert.notEqual(off!.fields.canonicalUrl, "https://shop.example/brawler");
  assert.equal(off!.productPageUrl, "https://yardsbrewing.com/beers/brawler");
});

test("P/Q. browser official ABV merges over beer_cache but not vault/user/barcode_cache", async () => {
  const discoveryDeps: OfficialBeerDiscoveryDeps = {
    fetchHtml: shellFetch(),
    browserFallbackEnabled: true,
    renderOfficialPage: async () => okBrowserPage()
  };

  const overCache = await applyOfficialBreweryBeerDiscovery({
    entityType: "packaged_beer",
    entityId: 101,
    candidate: makeCandidate("beer_cache", 4.0),
    row: {
      brewery: "Yards Brewing Co.",
      name: "Brawler",
      website_url: "https://yardsbrewing.com"
    },
    discoveryDeps
  });
  assert.equal(overCache.discovery?.status, "matched");
  assert.equal(overCache.candidate.abv.source, "official_brewery");
  assert.equal(overCache.candidate.abv.value, 4.2);

  for (const locked of ["vault", "user", "barcode_cache"] as const) {
    clearOfficialBeerDiscoveryCache();
    clearFieldOwnershipForTests();
    // Keeper-entered user values stamp human ownership. Unmarked vault is no
    // longer auto-repaired; leave it unmarked so ownership stays unresolved.
    if (locked === "user") {
      stampHumanFieldOwnership({
        entityType: "packaged_beer",
        entityId: 202,
        fields: ["abv"]
      });
    }
    const kept = await applyOfficialBreweryBeerDiscovery({
      entityType: "packaged_beer",
      entityId: 202,
      candidate: makeCandidate(locked, 5.5),
      row: {
        brewery: "Yards Brewing Co.",
        name: "Brawler",
        website_url: "https://yardsbrewing.com"
      },
      discoveryDeps
    });
    assert.equal(kept.candidate.abv.value, 5.5);
    assert.equal(
      kept.candidate.abv.source,
      locked
    );
    assert.equal(kept.abvUpdated, false);
  }
});

test("R/S. browser match stores official_product_page enrichment source", async () => {
  const applied = await applyOfficialBreweryBeerDiscovery({
    entityType: "packaged_beer",
    entityId: 303,
    candidate: makeCandidate("web"),
    row: {
      brewery: "Yards Brewing Co.",
      name: "Brawler",
      website_url: "https://yardsbrewing.com"
    },
    discoveryDeps: {
      fetchHtml: shellFetch(),
      browserFallbackEnabled: true,
      renderOfficialPage: async () => okBrowserPage()
    }
  });
  assert.equal(applied.productPageStored, true);
  const stored = getEnrichmentSource("packaged_beer", 303, "official_product_page");
  assert.ok(stored);
  assert.equal(stored!.sourceUrl, "https://yardsbrewing.com/beers/brawler");
});

test("T. browser failure stores no fake official source", async () => {
  const applied = await applyOfficialBreweryBeerDiscovery({
    entityType: "packaged_beer",
    entityId: 404,
    candidate: makeCandidate("web"),
    row: {
      brewery: "Yards Brewing Co.",
      name: "Brawler",
      website_url: "https://yardsbrewing.com"
    },
    discoveryDeps: {
      fetchHtml: shellFetch(),
      browserFallbackEnabled: true,
      renderOfficialPage: async () => ({ status: "timeout", reason: "timeout" })
    }
  });
  assert.equal(applied.productPageStored, false);
  assert.equal(getEnrichmentSource("packaged_beer", 404, "official_product_page"), null);
});

test("U. apply path does not expose inventory image mutation hooks", async () => {
  const applied = await applyOfficialBreweryBeerDiscovery({
    entityType: "packaged_beer",
    entityId: 505,
    candidate: makeCandidate("web"),
    row: {
      brewery: "Yards Brewing Co.",
      name: "Brawler",
      website_url: "https://yardsbrewing.com",
      image_url: "https://cdn.example/user-shelf.jpg"
    },
    discoveryDeps: {
      fetchHtml: shellFetch(),
      browserFallbackEnabled: true,
      renderOfficialPage: async () => okBrowserPage()
    }
  });
  assert.equal("inventoryImageUrl" in applied, false);
  assert.equal(applied.discovery?.status, "matched");
});

test("V/W/X/Y. spirits/wines short-circuit; search paths do not import browser adapter", async () => {
  const spirit = await applyOfficialBreweryBeerDiscovery({
    entityType: "spirit",
    entityId: 1,
    candidate: makeCandidate("web"),
    row: { name: "Bourbon", brand: "Maker" },
    discoveryDeps: {
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        throw new Error("spirits must not render");
      }
    }
  });
  assert.equal(spirit.attempted, false);

  const wine = await applyOfficialBreweryBeerDiscovery({
    entityType: "wine",
    entityId: 2,
    candidate: makeCandidate("web"),
    row: { name: "Cabernet", brand: "Winery" },
    discoveryDeps: {
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        throw new Error("wines must not render");
      }
    }
  });
  assert.equal(wine.attempted, false);

  const offenders: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) {
        if (["node_modules", "dist", "fixtures"].includes(name)) continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (path.includes("official_brewery_beer_browser")) continue;
      if (path.includes("official_brewery_beer_discovery")) continue;
      // Read-only ops smoke harness may import the browser adapter.
      if (path.includes("smoke_official_beer_browser")) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("official_brewery_beer_browser")) {
        offenders.push(path);
      }
    }
  }
  walk("src");
  assert.deepEqual(offenders, []);
});

test("browser vs static is transport — provenance remains official_brewery", () => {
  const merged = mergeField(field(4.0, "beer_cache"), field(4.2, "official_brewery"), "abv");
  assert.equal(merged.field.source, "official_brewery");
  assert.equal(merged.field.value, 4.2);
});
