/**
 * Official-domain authority for canonical URLs — fixtures/stubs only.
 * Off-domain <link rel="canonical"> must not become official_product_page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { field } from "./ingestion/candidate/index.js";
import { applyOfficialBreweryBeerDiscovery } from "./ingestion/jobs/official-brewery-beer.js";
import {
  clearEnrichmentSourcesForTests,
  getEnrichmentSource
} from "./ingestion/jobs/enrichment-sources.js";
import {
  clearOfficialBeerDiscoveryCache,
  discoverOfficialBeerProductPage,
  extractOfficialBeerMetadata,
  type OfficialBeerDiscoveryDeps
} from "./official_brewery_beer_discovery.js";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/official-brewery-beer"
);

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function withCanonical(html: string, canonicalHref: string): string {
  if (/rel=["']canonical["']/i.test(html)) {
    return html
      .replace(
        /(<link[^>]*rel=["']canonical["'][^>]*href=["'])([^"']+)(["'][^>]*>)/i,
        `$1${canonicalHref}$3`
      )
      .replace(
        /(<link[^>]*href=["'])([^"']+)(["'][^>]*rel=["']canonical["'][^>]*>)/i,
        `$1${canonicalHref}$3`
      );
  }
  return html.replace(
    /<\/head>/i,
    `<link rel="canonical" href="${canonicalHref}"/></head>`
  );
}

function yardsFetch(pageHtml: string): NonNullable<OfficialBeerDiscoveryDeps["fetchHtml"]> {
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
        html: pageHtml,
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

function baseCandidate() {
  return {
    primarySource: "web" as const,
    upc: field(null, "web"),
    name: field("Brawler", "web"),
    brand: field("Yards Brewing Co.", "web"),
    product_type: field("packaged_beer", "web"),
    category: field("English Brown Ale", "web"),
    abv: field(null, "web"),
    proof: field(null, "web"),
    volume_ml: field(null, "web"),
    origin: field(null, "web"),
    ttb_id: field(null, "web")
  };
}

test("A. same-domain canonical is accepted as official product URL", async () => {
  clearOfficialBeerDiscoveryCache();
  const html = withCanonical(
    fixture("yards-brawler.html"),
    "https://yardsbrewing.com/beers/brawler"
  );
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: yardsFetch(html) }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.equal(result.productPageUrl, "https://yardsbrewing.com/beers/brawler");
  assert.equal(result.fields.canonicalUrl, "https://yardsbrewing.com/beers/brawler");
});

test("B. www/subdomain canonical within official registered domain is accepted", async () => {
  clearOfficialBeerDiscoveryCache();
  const html = withCanonical(
    fixture("yards-brawler.html"),
    "https://www.yardsbrewing.com/beers/brawler"
  );
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: yardsFetch(html) }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.productPageUrl, "https://www.yardsbrewing.com/beers/brawler");
  assert.equal(result.fields.canonicalUrl, "https://www.yardsbrewing.com/beers/brawler");
  assert.equal(result.registeredDomain, "yardsbrewing.com");
});

test("C. off-domain canonical is rejected from trusted metadata", async () => {
  clearOfficialBeerDiscoveryCache();
  const offDomain = "https://untappd.com/b/yards-brewing-co-brawler";
  const html = withCanonical(fixture("yards-brawler.html"), offDomain);

  const extracted = extractOfficialBeerMetadata({
    html,
    pageUrl: "https://yardsbrewing.com/beers/brawler",
    beerName: "Brawler",
    breweryName: "Yards Brewing Co."
  });
  assert.equal(extracted.canonicalUrl, offDomain);

  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: yardsFetch(html) }
  );
  assert.equal(result.status, "matched");
  assert.notEqual(result.productPageUrl, offDomain);
  assert.equal(result.productPageUrl, "https://yardsbrewing.com/beers/brawler");
  assert.notEqual(result.fields.canonicalUrl, offDomain);
  assert.ok(
    result.fields.canonicalUrl == null ||
      result.fields.canonicalUrl === "https://yardsbrewing.com/beers/brawler"
  );
});

test("D. off-domain canonical cannot become enrichment_sources.source_url", async () => {
  clearOfficialBeerDiscoveryCache();
  clearEnrichmentSourcesForTests();
  const offDomain = "https://beeradvocate.com/beer/profile/123/456";
  const html = withCanonical(fixture("yards-brawler.html"), offDomain);

  const applied = await applyOfficialBreweryBeerDiscovery({
    entityType: "packaged_beer",
    entityId: 4242,
    candidate: baseCandidate(),
    row: {
      brewery: "Yards Brewing Co.",
      name: "Brawler",
      website_url: "https://yardsbrewing.com"
    },
    discoveryDeps: { fetchHtml: yardsFetch(html) }
  });

  assert.equal(applied.attempted, true);
  assert.equal(applied.productPageStored, true);
  assert.equal(applied.discovery?.status, "matched");
  assert.equal(applied.discovery?.productPageUrl, "https://yardsbrewing.com/beers/brawler");
  assert.notEqual(applied.discovery?.productPageUrl, offDomain);

  const stored = getEnrichmentSource("packaged_beer", 4242, "official_product_page");
  assert.ok(stored);
  assert.equal(stored!.sourceUrl, "https://yardsbrewing.com/beers/brawler");
  assert.notEqual(stored!.sourceUrl, offDomain);
  assert.ok(!stored!.sourceUrl.includes("beeradvocate.com"));
});

test("E. product discovery still matches the valid on-domain page", async () => {
  clearOfficialBeerDiscoveryCache();
  const html = withCanonical(
    fixture("yards-brawler.html"),
    "https://retailer.example/yards-brawler"
  );
  const result = await discoverOfficialBeerProductPage(
    {
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      breweryWebsiteUrl: "https://yardsbrewing.com"
    },
    { fetchHtml: yardsFetch(html) }
  );
  assert.equal(result.status, "matched");
  assert.equal(result.match, "exact_name");
  assert.equal(result.productPageUrl, "https://yardsbrewing.com/beers/brawler");
  assert.equal(result.fields.abv, 4.2);
  assert.equal(result.fields.productName, "Brawler");
  assert.ok(!String(result.productPageUrl).includes("retailer.example"));
  assert.ok(!String(result.fields.canonicalUrl).includes("retailer.example"));
});
