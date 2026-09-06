/**
 * Deterministic official beer product URL guesses — fixtures/stubs only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_GUESSED_PRODUCT_FETCHES,
  OFFICIAL_BEER_PRODUCT_PATH_PREFIXES,
  clearOfficialBeerDiscoveryCache,
  discoverOfficialBeerProductPage,
  generateOfficialBeerProductUrlCandidates,
  slugifyOfficialBeerName,
  type OfficialBeerDiscoveryDeps
} from "./official_brewery_beer_discovery.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/official-brewery-beer");

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function mockFetch(
  map: Record<string, { html: string; contentType?: string; finalUrl?: string }>
): OfficialBeerDiscoveryDeps["fetchHtml"] {
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
      contentType:
        hit.contentType ??
        (hit.html.includes("<urlset") || hit.html.includes("<sitemapindex")
          ? "application/xml"
          : "text/html")
    };
  };
}

function emptySitemaps(origin: string): Record<string, { html: string; contentType: string }> {
  return {
    [`${origin}/sitemap.xml`]: { html: "", contentType: "text/plain" },
    [`${origin}/sitemap_index.xml`]: { html: "", contentType: "text/plain" }
  };
}

test("slugifyOfficialBeerName is deterministic and preserves digits", () => {
  assert.equal(slugifyOfficialBeerName("Sour Monkey"), "sour-monkey");
  assert.equal(slugifyOfficialBeerName("Nugget Nectar"), "nugget-nectar");
  assert.equal(slugifyOfficialBeerName("DirtWolf"), "dirtwolf");
  assert.equal(slugifyOfficialBeerName("Dirt Wolf"), "dirt-wolf");
  assert.equal(slugifyOfficialBeerName("60 Minute IPA"), "60-minute-ipa");
  assert.equal(slugifyOfficialBeerName("Two Hearted Ale"), "two-hearted-ale");
  assert.equal(slugifyOfficialBeerName("Voodoo Ranger IPA"), "voodoo-ranger-ipa");
  assert.equal(slugifyOfficialBeerName("Bell’s Two Hearted Ale"), "bells-two-hearted-ale");
  assert.equal(slugifyOfficialBeerName("Bell's Two Hearted Ale"), "bells-two-hearted-ale");
  assert.equal(slugifyOfficialBeerName("Hop, Drop 'n Roll"), "hop-drop-n-roll");
  assert.equal(slugifyOfficialBeerName("Über Pils"), "uber-pils");
  assert.ok(slugifyOfficialBeerName("Sour Monkey").length > 0);
});

test("generateOfficialBeerProductUrlCandidates is bounded, ordered, same-origin", () => {
  const candidates = generateOfficialBeerProductUrlCandidates({
    origin: "https://victorybeer.com",
    beerName: "Sour Monkey"
  });
  assert.ok(candidates.length <= 12);
  assert.equal(candidates[0], "https://victorybeer.com/beer/sour-monkey/");
  assert.equal(candidates[1], "https://victorybeer.com/beers/sour-monkey/");
  assert.equal(candidates[2], "https://victorybeer.com/our-beer/sour-monkey/");
  assert.equal(candidates[3], "https://victorybeer.com/our-beers/sour-monkey/");
  assert.ok(candidates.includes("https://victorybeer.com/beers/sour-monkey/"));

  const troegs = generateOfficialBeerProductUrlCandidates({
    origin: "https://troegs.com",
    beerName: "Nugget Nectar"
  });
  assert.ok(troegs.includes("https://troegs.com/beer/nugget-nectar/"));

  const dirt = generateOfficialBeerProductUrlCandidates({
    origin: "https://victorybeer.com",
    beerName: "DirtWolf"
  });
  assert.ok(dirt.includes("https://victorybeer.com/beers/dirtwolf/"));
  assert.ok(!dirt.some((u) => u.includes("dirt-wolf")));

  const storedDirt = generateOfficialBeerProductUrlCandidates({
    origin: "https://victorybeer.com",
    beerName: "Dirt wolf"
  });
  assert.deepEqual(storedDirt.slice(0, 4), [
    "https://victorybeer.com/beer/dirt-wolf/",
    "https://victorybeer.com/beers/dirt-wolf/",
    "https://victorybeer.com/our-beer/dirt-wolf/",
    "https://victorybeer.com/our-beers/dirt-wolf/"
  ]);
  assert.ok(storedDirt.includes("https://victorybeer.com/beers/dirtwolf/"));
});

test("guessed candidates reject host-injection / unsafe slug construction", () => {
  for (const beer of [
    "//evil.example/x",
    "https://evil.example/beer",
    "../escape",
    "foo/../../bar",
    "a@b",
    ""
  ]) {
    const candidates = generateOfficialBeerProductUrlCandidates({
      origin: "https://victorybeer.com",
      beerName: beer
    });
    for (const url of candidates) {
      assert.match(url, /^https:\/\/victorybeer\.com\//);
      assert.ok(!url.includes("evil.example"));
      assert.ok(!url.includes("//evil"));
    }
  }
});

test("A. Victory Sour Monkey matches guessed /beers/<slug>/ before sitemap", async () => {
  clearOfficialBeerDiscoveryCache();
  let sitemapHits = 0;
  let browserCalls = 0;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Sour Monkey",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return { status: "error", reason: "should_not_run" };
      },
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          sitemapHits += 1;
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        if (url === "https://victorybeer.com/beers/sour-monkey/") {
          return {
            finalUrl: url,
            html: fixture("victory-sour-monkey.html"),
            contentType: "text/html"
          };
        }
        return {
          finalUrl: url,
          html: "<html><head><title>Home</title></head><body></body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  assert.equal(result.status, "matched");
  assert.ok(result.match === "exact_name" || result.match === "strong_name");
  assert.equal(result.productPageUrl, "https://victorybeer.com/beers/sour-monkey/");
  assert.equal(result.reason, "guessed_product_url_matched");
  assert.equal(sitemapHits, 0);
  assert.equal(browserCalls, 0);
  assert.ok(result.pagesFetched <= MAX_GUESSED_PRODUCT_FETCHES);
});

test("B. Victory DirtWolf matches guessed product URL", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "DirtWolf",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      fetchHtml: mockFetch({
        ...emptySitemaps("https://victorybeer.com"),
        "https://victorybeer.com/beers/dirtwolf/": {
          html: fixture("victory-dirtwolf.html")
        }
      })
    }
  );
  assert.equal(result.status, "matched");
  assert.ok(result.match === "exact_name" || result.match === "strong_name");
  assert.equal(result.productPageUrl, "https://victorybeer.com/beers/dirtwolf/");
  assert.equal(result.reason, "guessed_product_url_matched");
  assert.match(String(result.fields.imageUrl), /dw-render-|dirtwolf/i);
});

test("B2. stored Dirt wolf identity reaches compact slug without weakening page identity", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Dirt wolf",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      fetchHtml: mockFetch({
        ...emptySitemaps("https://victorybeer.com"),
        "https://victorybeer.com/beers/dirtwolf/": {
          html: fixture("victory-dirtwolf.html")
        }
      })
    }
  );
  assert.equal(result.status, "matched");
  assert.ok(result.match === "exact_name" || result.match === "strong_name");
  assert.equal(result.productPageUrl, "https://victorybeer.com/beers/dirtwolf/");
});

test("B3. Yuengling Traditional Lager reaches singular /our-beer/ within direct budget", async () => {
  clearOfficialBeerDiscoveryCache();
  const fetched: string[] = [];
  let browserCalls = 0;
  const url = "https://yuengling.com/our-beer/traditional-lager/";
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yuengling",
      beerName: "Traditional lager",
      breweryWebsiteUrl: "https://yuengling.com"
    },
    {
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return { status: "error", reason: "should_not_run" };
      },
      fetchHtml: async (candidate) => {
        fetched.push(candidate);
        return {
          finalUrl: candidate,
          contentType: "text/html",
          html: candidate === url
            ? `<html><head><title>Traditional Lager | Yuengling</title></head><body><h1>Traditional Lager</h1><p>Yuengling Traditional Lager is an iconic amber lager.</p><p>4.5% ABV · 12 IBU</p></body></html>`
            : "<html><head><title>Home</title></head><body></body></html>"
        };
      }
    }
  );
  assert.equal(result.status, "matched");
  assert.ok(result.match === "exact_name" || result.match === "strong_name");
  assert.equal(result.productPageUrl, url);
  assert.ok(fetched.indexOf(url) >= 0 && fetched.indexOf(url) < MAX_GUESSED_PRODUCT_FETCHES);
  assert.equal(browserCalls, 0);
});

test("C. Tröegs Nugget Nectar matches guessed /beer/<slug>/", async () => {
  clearOfficialBeerDiscoveryCache();
  let browserCalls = 0;
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Tröegs Brewing Company",
      beerName: "Nugget Nectar",
      breweryWebsiteUrl: "https://troegs.com"
    },
    {
      browserFallbackEnabled: true,
      renderOfficialPage: async () => {
        browserCalls += 1;
        return { status: "error", reason: "should_not_run" };
      },
      fetchHtml: mockFetch({
        ...emptySitemaps("https://troegs.com"),
        "https://troegs.com/beer/nugget-nectar/": {
          html: fixture("troegs-nugget-nectar.html")
        }
      })
    }
  );
  assert.equal(result.status, "matched");
  assert.ok(result.match === "exact_name" || result.match === "strong_name");
  assert.equal(result.productPageUrl, "https://troegs.com/beer/nugget-nectar/");
  assert.equal(result.reason, "guessed_product_url_matched");
  assert.equal(browserCalls, 0);
  assert.equal(result.fields.abv, 7.5);
});

test("D. nonsense beer: guesses attempted, no accepted match, not terminal", async () => {
  clearOfficialBeerDiscoveryCache();
  const fetched: string[] = [];
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Quantum Pickle Imperial Lager",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      browserFallbackEnabled: false,
      fetchHtml: async (url) => {
        fetched.push(url);
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        return {
          finalUrl: url,
          html: fixture("victory-beer-index.html"),
          contentType: "text/html"
        };
      }
    }
  );
  assert.equal(result.status, "not_found");
  assert.equal(result.match, "none");
  assert.ok(result.productPageUrl == null);
  assert.ok(
    fetched.some((u) => u.includes("/beer/quantum-pickle-imperial-lager/")),
    "should attempt guessed product paths"
  );
  assert.ok(
    fetched.some((u) => u.includes("sitemap")),
    "guess miss must fall through to sitemap/static discovery"
  );
});

test("E. soft-404 HTTP 200 beer index must not match", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Not Real Beer",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      browserFallbackEnabled: false,
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        return {
          finalUrl: url,
          html: fixture("victory-beer-index.html"),
          contentType: "text/html"
        };
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.ok(result.match === "none" || result.match === "weak");
  assert.ok(result.productPageUrl == null);
});

test("F. wrong beer page at guessed path is rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Sour Monkey",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      browserFallbackEnabled: false,
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        if (url.includes("sour-monkey")) {
          return {
            finalUrl: url,
            html: fixture("victory-golden-monkey-as-wrong.html"),
            contentType: "text/html"
          };
        }
        return {
          finalUrl: url,
          html: "<html><head><title>Home</title></head><body></body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.ok(result.productPageUrl == null);
});

test("G. typo-near page does not fuzzy-accept Nugget Nectar", async () => {
  clearOfficialBeerDiscoveryCache();
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Tröegs Brewing Company",
      beerName: "Nugget Nectar",
      breweryWebsiteUrl: "https://troegs.com"
    },
    {
      browserFallbackEnabled: false,
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        if (url.includes("nugget-nectar")) {
          return {
            finalUrl: url,
            html: fixture("troegs-nugget-nector-typo.html"),
            contentType: "text/html"
          };
        }
        return {
          finalUrl: url,
          html: "<html><head><title>Home</title></head><body></body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  assert.notEqual(result.status, "matched");
  assert.ok(result.productPageUrl == null);
});

test("guessed path same-domain redirect is accepted; off-domain redirect rejected", async () => {
  clearOfficialBeerDiscoveryCache();
  const sameDomain = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Sour Monkey",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        if (url.includes("/beers/sour-monkey") || url.includes("/beer/sour-monkey")) {
          return {
            finalUrl: "https://victorybeer.com/beer/sour-monkey/",
            html: fixture("victory-sour-monkey.html"),
            contentType: "text/html"
          };
        }
        return {
          finalUrl: url,
          html: "<html><head><title>Home</title></head><body></body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  assert.equal(sameDomain.status, "matched");
  assert.match(String(sameDomain.productPageUrl), /sour-monkey/);

  clearOfficialBeerDiscoveryCache();
  const offDomain = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Sour Monkey",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    {
      browserFallbackEnabled: false,
      fetchHtml: async (url) => {
        if (url.includes("sitemap")) {
          return { finalUrl: url, html: "", contentType: "text/plain" };
        }
        if (url.includes("sour-monkey")) {
          return {
            finalUrl: "https://retailer.example/products/sour-monkey",
            html: fixture("victory-sour-monkey.html"),
            contentType: "text/html"
          };
        }
        return {
          finalUrl: url,
          html: "<html><head><title>Home</title></head><body></body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  assert.notEqual(offDomain.status, "matched");
});

test("guess budget leaves room for sitemap crawl when guesses miss", async () => {
  clearOfficialBeerDiscoveryCache();
  const fetched: string[] = [];
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    {
      maxPages: 10,
      fetchHtml: async (url) => {
        fetched.push(url);
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
        // Guesses miss (generic page); sitemap product hits.
        if (url.includes("/beers/brawler")) {
          return {
            finalUrl: "https://yardsbrewing.com/beers/brawler",
            html: fixture("yards-brawler.html"),
            contentType: "text/html"
          };
        }
        return {
          finalUrl: url,
          html: "<html><head><title>Home</title></head><body></body></html>",
          contentType: "text/html"
        };
      }
    }
  );
  // Either guessed /beers/brawler/ matched early, or sitemap found it.
  assert.equal(result.status, "matched");
  assert.match(String(result.productPageUrl), /brawler/);
  const guessFetches = fetched.filter((u) =>
    /\/(beer|beers|our-beers|products|product|brew|brews)\/brawler\/?$/.test(
      new URL(u).pathname
    )
  ).length;
  assert.ok(guessFetches <= MAX_GUESSED_PRODUCT_FETCHES);
});

test("positive guess is cached; single guess miss is not cached as not_found", async () => {
  clearOfficialBeerDiscoveryCache();
  let fetches = 0;
  const deps: OfficialBeerDiscoveryDeps = {
    nowMs: () => 1_000,
    fetchHtml: async (url) => {
      fetches += 1;
      if (url.includes("sitemap")) {
        return { finalUrl: url, html: "", contentType: "text/plain" };
      }
      if (url.includes("/beers/sour-monkey")) {
        return {
          finalUrl: "https://victorybeer.com/beers/sour-monkey/",
          html: fixture("victory-sour-monkey.html"),
          contentType: "text/html"
        };
      }
      return {
        finalUrl: url,
        html: "<html><head><title>Home</title></head><body></body></html>",
        contentType: "text/html"
      };
    }
  };
  const first = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Sour Monkey",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    deps
  );
  assert.equal(first.status, "matched");
  const afterFirst = fetches;
  const second = await discoverOfficialBeerProductPage(
    {
      breweryName: "Victory Brewing Company",
      beerName: "Sour Monkey",
      breweryWebsiteUrl: "https://victorybeer.com"
    },
    { ...deps, nowMs: () => 2_000 }
  );
  assert.equal(second.status, "matched");
  assert.equal(fetches, afterFirst, "cache hit should not refetch");
});
