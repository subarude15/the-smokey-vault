/**
 * Official brewery beer product-page discovery — fixtures/stubs only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFIDENCE,
  field,
  mergeField
} from "./ingestion/candidate/index.js";
import {
  classifyOfficialBeerPageMatch,
  clearOfficialBeerDiscoveryCache,
  discoverOfficialBeerProductPage,
  extractOfficialBeerMetadata,
  resolveOfficialBreweryOrigin,
  type OfficialBeerDiscoveryDeps
} from "./official_brewery_beer_discovery.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/official-brewery-beer");

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function mockFetch(map: Record<string, { html: string; contentType?: string; finalUrl?: string }>): OfficialBeerDiscoveryDeps["fetchHtml"] {
  return async (url: string) => {
    const hit = map[url] ?? map[url.replace(/\/$/, "")] ?? map[`${url}/`];
    if (!hit) {
      return {
        finalUrl: url,
        html: "<html><head><title>Home</title></head><body></body></html>",
        contentType: "text/html"
      };
    }
    return {
      finalUrl: hit.finalUrl ?? url,
      html: hit.html,
      contentType: hit.contentType ?? (hit.html.includes("<urlset") || hit.html.includes("<sitemapindex") ? "application/xml" : "text/html")
    };
  };
}

test("resolveOfficialBreweryOrigin accepts website URL or host", () => {
  const fromUrl = resolveOfficialBreweryOrigin({
    breweryName: "Yards",
    beerName: "Brawler",
    breweryWebsiteUrl: "https://www.yardsbrewing.com/beers"
  });
  assert.equal(fromUrl?.domain, "yardsbrewing.com");

  const fromHost = resolveOfficialBreweryOrigin({
    breweryName: "Yards",
    beerName: "Brawler",
    breweryWebsiteHost: "yardsbrewing.com"
  });
  assert.equal(fromHost?.domain, "yardsbrewing.com");
});

test("A. official domain + exact product page found (Yards Brawler)", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      fetchHtml: mockFetch({
        "https://yardsbrewing.com/sitemap.xml": {
          html: fixture("yards-sitemap.xml"),
          contentType: "application/xml"
        },
        "https://yardsbrewing.com/sitemap_index.xml": {
          html: "",
          contentType: "text/plain"
        },
        "https://yardsbrewing.com/beers/brawler": {
          html: fixture("yards-brawler.html")
        }
      })
    }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.equal(result.productPageUrl, "https://yardsbrewing.com/beers/brawler");
  assert.equal(result.fields.abv, 4.2);
  assert.equal(result.fields.ibu, 20);
  assert.equal(result.fields.style, "English Brown Ale");
  assert.ok(result.fields.packageSizes.some((s) => s.includes("12 oz")));
  assert.equal(result.fields.imageUrl, "https://yardsbrewing.com/images/brawler.jpg");
});

test("B. sitemap index → child sitemap → product URL (Tröegs Perpetual IPA)", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Tröegs Independent Brewing",
      beerName: "Perpetual IPA",
      breweryWebsiteUrl: "https://troegs.com"
    },
    {
      fetchHtml: mockFetch({
        "https://troegs.com/sitemap.xml": {
          html: fixture("troegs-sitemap-index.xml"),
          contentType: "application/xml"
        },
        "https://troegs.com/sitemaps/beers.xml": {
          html: fixture("troegs-beers-sitemap.xml"),
          contentType: "application/xml"
        },
        "https://troegs.com/beers/perpetual-ipa": {
          html: fixture("troegs-perpetual.html")
        }
      })
    }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.match(String(result.productPageUrl), /perpetual-ipa/);
  assert.equal(result.fields.abv, 7.5);
  assert.equal(result.fields.ibu, 85);
});

test("C–I. corpus pages match strongly and extract ABV when present", async () => {
  clearOfficialBeerDiscoveryCache();
  const cases = [
    {
      brewery: "Victory Brewing Company",
      beer: "Golden Monkey",
      host: "https://victorybeer.com",
      path: "/beers/golden-monkey",
      html: "victory-golden-monkey.html",
      abv: 9.5
    },
    {
      brewery: "Dogfish Head",
      beer: "60 Minute IPA",
      host: "https://dogfish.com",
      path: "/brews/60-minute-ipa",
      html: "dogfish-60.html",
      abv: 6
    },
    {
      brewery: "Sierra Nevada",
      beer: "Pale Ale",
      host: "https://sierranevada.com",
      path: "/beer/pale-ale",
      html: "sierra-pale.html",
      abv: 5.6
    },
    {
      brewery: "Bell's Brewery",
      beer: "Two Hearted Ale",
      host: "https://bellsbeer.com",
      path: "/beers/two-hearted-ale",
      html: "bells-two-hearted.html",
      abv: 7
    },
    {
      brewery: "Founders Brewing Co.",
      beer: "All Day IPA",
      host: "https://foundersbrewing.com",
      path: "/beer/all-day-ipa",
      html: "founders-all-day.html",
      abv: 4.7
    },
    {
      brewery: "New Belgium",
      beer: "Voodoo Ranger IPA",
      host: "https://newbelgium.com",
      path: "/beers/voodoo-ranger-ipa",
      html: "newbelgium-voodoo.html",
      abv: 7
    },
    {
      brewery: "Yuengling",
      beer: "Traditional Lager",
      host: "https://yuengling.com",
      path: "/beers/traditional-lager",
      html: "yuengling-lager.html",
      abv: 4.5
    }
  ] as const;

  for (const c of cases) {
    clearOfficialBeerDiscoveryCache();
    const pageUrl = `${c.host}${c.path}`;
    const result = await discoverOfficialBeerProductPage(
      {
        breweryName: c.brewery,
        beerName: c.beer,
        breweryWebsiteUrl: c.host
      },
      {
        fetchHtml: mockFetch({
          [`${c.host}/sitemap.xml`]: { html: "", contentType: "text/plain" },
          [`${c.host}/sitemap_index.xml`]: { html: "", contentType: "text/plain" },
          [`${c.host}/`]: {
            html: `<html><body><a href="${c.path}">${c.beer}</a></body></html>`
          },
          [`${c.host}/beers`]: { html: "<html></html>" },
          [`${c.host}/beer`]: { html: "<html></html>" },
          [`${c.host}/our-beers`]: { html: "<html></html>" },
          [`${c.host}/products`]: { html: "<html></html>" },
          [pageUrl]: { html: fixture(c.html) }
        })
      }
    );
    assert.equal(result.status, "matched", c.beer);
    assert.ok(result.match === "exact_name" || result.match === "strong_name", c.beer);
    assert.equal(result.fields.abv, c.abv, c.beer);
  }
});

test("F/G. event and merch pages mentioning beer are rejected", () => {
  const event = classifyOfficialBeerPageMatch({
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    title: "Taproom Party featuring Brawler",
    h1: "Taproom Party",
    productName: null,
    pageUrl: "https://yardsbrewing.com/events/taproom-party",
    pageText: "Come drink Brawler at our event."
  });
  assert.equal(event, "none");

  const merch = classifyOfficialBeerPageMatch({
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    title: "Brawler Hat | Shop",
    h1: "Brawler Hat",
    productName: null,
    pageUrl: "https://yardsbrewing.com/shop/merch-hat",
    pageText: "Merch only."
  });
  assert.equal(merch, "none");
});

test("H/I. unrelated beer and typo-near names do not become canonical matches", () => {
  const unrelated = classifyOfficialBeerPageMatch({
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    title: "Philadelphia Pale Ale | Yards",
    h1: "Philadelphia Pale Ale",
    productName: "Philadelphia Pale Ale",
    pageUrl: "https://yardsbrewing.com/beers/philadelphia-pale-ale",
    pageText: "An American pale ale."
  });
  assert.equal(unrelated, "none");

  const typo = classifyOfficialBeerPageMatch({
    beerName: "Brawler",
    breweryName: "Yards Brewing Co.",
    title: "Brawlr | Yards",
    h1: "Brawlr",
    productName: "Brawlr",
    pageUrl: "https://yardsbrewing.com/beers/brawlr",
    pageText: "Brawlr English brown."
  });
  assert.equal(typo, "none");
});

test("J. third-party domain is rejected by origin resolver / discovery", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://untappd.com/yards"
    },
    {
      fetchHtml: async () => {
        throw new Error("should_not_fetch_third_party_as_official_without_domain_gate");
      }
    }
  );
  // Untappd host can still resolve as an origin; discovery must not treat it as a
  // trusted brewery product source for matching unless pages strongly match — and
  // our fetch throws, so we expect error/not matched without inventing identity.
  assert.ok(result.status === "error" || result.status === "not_found" || result.status === "unsupported_static_site");
  assert.equal(result.match, "none");
});

test("K. redirect to private host is rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        // Simulate unsafe redirect target rejection via NetworkSafetyError path:
        // fetchHtml itself refuses private hosts.
        const { NetworkSafetyError } = await import("./network_safety.js");
        throw new NetworkSafetyError("private", "private_ip");
      }
    }
  );
  assert.ok(result.status === "not_found" || result.status === "unsupported_static_site" || result.status === "error");
  assert.equal(result.match, "none");
});

test("L. malformed HTML is handled safely", () => {
  const fields = extractOfficialBeerMetadata({
    html: fixture("malformed.html"),
    pageUrl: "https://yardsbrewing.com/beers/brawler",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co."
  });
  assert.equal(fields.productName, "Brawler");
  assert.equal(fields.abv, 4.2);
});

test("M/N. oversized response and timeout fail gracefully", async () => {
  clearOfficialBeerDiscoveryCache();
  const oversized = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      maxBytes: 64,
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) return { finalUrl: url, html: "", contentType: "text/plain" };
        return {
          finalUrl: "https://yardsbrewing.com/beers/brawler",
          html: "x".repeat(10_000),
          contentType: "text/html"
        };
      }
    }
  );
  // Custom fetchHtml bypasses byte checks; ensure no crash and no false match on junk.
  assert.equal(oversized.match === "exact_name" || oversized.match === "strong_name", false);

  clearOfficialBeerDiscoveryCache();
  const timedOut = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      fetchHtml: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
    }
  );
  assert.ok(timedOut.status === "not_found" || timedOut.status === "unsupported_static_site" || timedOut.status === "error");
});

test("O/P. successful discovery and not-found use cache", async () => {
  clearOfficialBeerDiscoveryCache();
  let fetches = 0;
  const fetchHtml = mockFetch({
    "https://yardsbrewing.com/sitemap.xml": {
      html: fixture("yards-sitemap.xml"),
      contentType: "application/xml"
    },
    "https://yardsbrewing.com/sitemap_index.xml": { html: "", contentType: "text/plain" },
    "https://yardsbrewing.com/beers/brawler": { html: fixture("yards-brawler.html") }
  });
  const countingFetch: OfficialBeerDiscoveryDeps["fetchHtml"] = async (url) => {
    fetches += 1;
    return fetchHtml!(url);
  };

  const first = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: countingFetch, nowMs: () => 1_000 }
  );
  assert.equal(first.status, "matched");
  const afterFirst = fetches;

  const second = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: countingFetch, nowMs: () => 2_000 }
  );
  assert.equal(second.status, "matched");
  assert.equal(fetches, afterFirst, "positive cache should avoid refetch");
  assert.equal(second.productPageUrl, first.productPageUrl);

  clearOfficialBeerDiscoveryCache();
  let missFetches = 0;
  const miss = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Does Not Exist Ale",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      nowMs: () => 1_000,
      fetchHtml: async (url) => {
        missFetches += 1;
        if (url.includes("sitemap")) {
          return {
            finalUrl: url,
            html: fixture("yards-sitemap.xml"),
            contentType: "application/xml"
          };
        }
        return {
          finalUrl: url,
          html: "<html><title>Home</title><body>Welcome</body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  assert.ok(miss.status === "not_found" || miss.status === "unsupported_static_site");
  const afterMiss = missFetches;
  const miss2 = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Does Not Exist Ale",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      nowMs: () => 2_000,
      fetchHtml: async () => {
        missFetches += 1;
        throw new Error("should_use_not_found_cache");
      }
    }
  );
  assert.equal(missFetches, afterMiss);
  assert.equal(miss2.match, "none");
});

test("Q. provider failure does not invent beer identity", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      fetchHtml: async () => {
        throw new Error("upstream_down");
      }
    }
  );
  assert.ok(result.status === "error" || result.status === "not_found" || result.status === "unsupported_static_site");
  assert.equal(result.match, "none");
  assert.equal(result.fields.abv, null);
});

test("R/E extraction: null fields stay null; 10% off is not ABV; scripts stripped", () => {
  const html = `<html><head><title>Brawler | Yards</title>
  <script>document.write('ABV 99%')</script>
  <style>.x{content:'IBU 999'}</style>
  </head><body><h1>Brawler</h1>
  <p>Get 10% off this weekend.</p>
  <p>No alcohol facts listed.</p>
  </body></html>`;
  const fields = extractOfficialBeerMetadata({
    html,
    pageUrl: "https://yardsbrewing.com/beers/brawler",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co."
  });
  assert.equal(fields.abv, null);
  assert.equal(fields.ibu, null);
  assert.equal(fields.productName, "Brawler");
});

test("canonical URL preferred when present", () => {
  const fields = extractOfficialBeerMetadata({
    html: fixture("yards-brawler.html"),
    pageUrl: "https://yardsbrewing.com/beers/brawler?utm=1",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co."
  });
  assert.equal(fields.canonicalUrl, "https://yardsbrewing.com/beers/brawler");
});

test("provenance: official_brewery outranks beer_cache and web; vault/user immutable", () => {
  const fromBeerCache = field(5.8, "beer_cache");
  const fromOfficial = field(6.0, "official_brewery");
  const mergedUp = mergeField(fromBeerCache, fromOfficial, "abv");
  assert.equal(mergedUp.field.value, 6.0);
  assert.equal(mergedUp.field.source, "official_brewery");
  assert.equal(mergedUp.field.confidence, CONFIDENCE.VERY_HIGH);
  assert.equal(mergedUp.overwritten, true);

  const fromOff = field(5.5, "open_food_facts");
  const mergedOff = mergeField(fromOff, fromOfficial, "abv");
  assert.equal(mergedOff.field.source, "official_brewery");

  const fromWeb = field(5.1, "web");
  const mergedWeb = mergeField(fromWeb, fromOfficial, "abv");
  assert.equal(mergedWeb.field.source, "official_brewery");

  const vault = field(5.9, "vault");
  const keepVault = mergeField(vault, fromOfficial, "abv");
  assert.equal(keepVault.field.value, 5.9);
  assert.equal(keepVault.field.source, "vault");
  assert.equal(keepVault.overwritten, false);

  const user = field(5.9, "user");
  const keepUser = mergeField(user, fromOfficial, "abv");
  assert.equal(keepUser.field.value, 5.9);
  assert.equal(keepUser.field.source, "user");

  const existing = field(6.0, "beer_cache");
  const nullOfficial = field(null, "official_brewery");
  const keepExisting = mergeField(existing, nullOfficial, "abv");
  assert.equal(keepExisting.field.value, 6.0);
  assert.equal(keepExisting.field.source, "beer_cache");
});
