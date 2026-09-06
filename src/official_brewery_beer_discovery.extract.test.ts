/**
 * Official brewery product-page extraction — fixtures/stubs only.
 * Discovery strategy is unchanged; these tests cover style/description/image.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scoreImageCandidateBase, type ImageCandidate } from "./ingestion/enrichment/image-score.js";
import {
  collectJsonLdImageUrls,
  extractOfficialBeerImageCandidates,
  extractOfficialBeerMetadata,
  isRejectedOfficialImageCandidate
} from "./official_brewery_beer_discovery.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/official-brewery-beer");

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

test("A. Victory Sour Monkey extracts style, notes, and product image", () => {
  const fields = extractOfficialBeerMetadata({
    html: fixture("victory-sour-monkey.html"),
    pageUrl: "https://victorybeer.com/beers/sour-monkey/",
    beerName: "Sour Monkey",
    breweryName: "Victory Brewing Company"
  });
  assert.equal(fields.abv, 9.5);
  assert.equal(fields.style, "Sour Tripel");
  assert.ok(fields.description && /belgian yeast|citrus/i.test(fields.description));
  assert.match(String(fields.imageUrl), /Sour-Monkey.*\.webp$/i);
  assert.doesNotMatch(String(fields.imageUrl), /logo/i);
});

test("B. Victory DirtWolf extracts Double IPA, IBU, notes, and image", () => {
  const fields = extractOfficialBeerMetadata({
    html: fixture("victory-dirtwolf.html"),
    pageUrl: "https://victorybeer.com/beers/dirtwolf/",
    beerName: "DirtWolf",
    breweryName: "Victory Brewing Company"
  });
  assert.equal(fields.abv, 8.7);
  assert.equal(fields.ibu, 85);
  assert.equal(fields.style, "Double IPA");
  assert.ok(fields.description && /dry-hopping|citrus/i.test(fields.description));
  assert.match(String(fields.imageUrl), /dw-render/i);
});

test("C. Tröegs Nugget Nectar extracts style, description, and JSON-LD image", () => {
  const fields = extractOfficialBeerMetadata({
    html: fixture("troegs-nugget-nectar.html"),
    pageUrl: "https://troegs.com/beer/nugget-nectar/",
    beerName: "Nugget Nectar",
    breweryName: "Tröegs Brewing Company"
  });
  assert.equal(fields.abv, 7.5);
  assert.equal(fields.ibu, 93);
  assert.equal(fields.style, "Imperial Amber Ale");
  assert.ok(fields.description && /nugget hops/i.test(fields.description));
  assert.equal(fields.imageUrl, "https://troegs.com/img/nugget-nectar.jpg");
});

test("JSON-LD image shapes: string, array, ImageObject url/contentUrl", () => {
  assert.deepEqual(collectJsonLdImageUrls("https://cdn.example/beer.jpg"), [
    "https://cdn.example/beer.jpg"
  ]);
  assert.deepEqual(
    collectJsonLdImageUrls([
      "https://cdn.example/front.jpg",
      "https://cdn.example/back.jpg"
    ]),
    ["https://cdn.example/front.jpg", "https://cdn.example/back.jpg"]
  );
  assert.deepEqual(
    collectJsonLdImageUrls({
      "@type": "ImageObject",
      url: "https://cdn.example/beer.jpg"
    }),
    ["https://cdn.example/beer.jpg"]
  );
  assert.deepEqual(
    collectJsonLdImageUrls({
      "@type": "ImageObject",
      contentUrl: "https://cdn.example/beer.jpg"
    }),
    ["https://cdn.example/beer.jpg"]
  );
});

test("og:image relative URL resolves against product page", () => {
  const candidates = extractOfficialBeerImageCandidates({
    html: `<html><head><meta property="og:image" content="/images/beer.jpg"></head><body></body></html>`,
    pageUrl: "https://brewery.example/beers/foo/",
    beerName: "Foo"
  });
  assert.equal(candidates[0], "https://brewery.example/images/beer.jpg");
});

test("twitter:image is accepted when og:image missing", () => {
  const candidates = extractOfficialBeerImageCandidates({
    html: `<html><head><meta name="twitter:image" content="https://cdn.example/tw.jpg"></head><body></body></html>`,
    pageUrl: "https://brewery.example/beers/foo/",
    beerName: "Foo"
  });
  assert.equal(candidates[0], "https://cdn.example/tw.jpg");
});

test("bad image candidates are rejected", () => {
  for (const raw of [
    "data:image/png;base64,aaaa",
    "javascript:alert(1)",
    "",
    "https://brewery.example/favicon.ico",
    "https://brewery.example/logo.svg",
    "https://brewery.example/pixel-1x1.png"
  ]) {
    assert.equal(isRejectedOfficialImageCandidate(raw), true, raw);
  }
  const candidates = extractOfficialBeerImageCandidates({
    html: `<html><body>
      <img src="/logo.svg" alt="logo">
      <img src="/favicon.ico" alt="">
      <img src="data:image/png;base64,aaa" alt="x">
      <img src="/images/product-can.png" alt="Foo Ale" width="1" height="1">
    </body></html>`,
    pageUrl: "https://brewery.example/beers/foo-ale/",
    beerName: "Foo Ale"
  });
  assert.equal(candidates.length, 0);
});

test("description boilerplate is not selected", () => {
  const fields = extractOfficialBeerMetadata({
    html: `<html><body><h1>Foo Ale</h1>
      <p>You must be 21 to enter. Sign up for our newsletter. We use cookies. Shop now. Find a retailer.</p>
    </body></html>`,
    pageUrl: "https://brewery.example/beers/foo-ale/",
    beerName: "Foo Ale",
    breweryName: "Example Brewing"
  });
  assert.equal(fields.description, null);
  assert.equal(fields.tastingNotes, null);
});

test("marketing phrases are not treated as beer style", () => {
  const fields = extractOfficialBeerMetadata({
    html: `<html><body><h1>Foo Ale</h1>
      <p>Bold and adventurous. Hop-forward. Seasonal favorite.</p>
    </body></html>`,
    pageUrl: "https://brewery.example/beers/foo-ale/",
    beerName: "Foo Ale",
    breweryName: "Example Brewing"
  });
  assert.equal(fields.style, null);
});

test("DirtWolf: official product-page image ranks above generic third-party", () => {
  const official: ImageCandidate = {
    url: "https://victorybeer.com/wp-content/uploads/2026/07/dw-render-.webp",
    sourceUrl: "https://victorybeer.com/beers/dirtwolf/",
    sourceType: "official",
    width: 800,
    height: 800,
    mimeType: "image/webp",
    identityMatched: true
  };
  const generic: ImageCandidate = {
    url: "https://retailer.example/unrelated-bottle.jpg",
    sourceUrl: "https://retailer.example/unrelated-bottle.jpg",
    sourceType: "unknown",
    width: 800,
    height: 800,
    mimeType: "image/jpeg",
    identityMatched: false
  };
  assert.ok(scoreImageCandidateBase(official) > scoreImageCandidateBase(generic));
});

test("apply path source does not write inventory.image_url", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "ingestion/jobs/official-brewery-beer.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /image_url/);
  assert.doesNotMatch(source, /upsertProductImage/);
  assert.match(source, /official_product_page|officialNotes|abv/);
});
