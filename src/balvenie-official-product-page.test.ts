/**
 * Official product-page discovery for image enrichment (Balvenie UPC 083664871681).
 * Fakes only — no live SearXNG / Ollama / external hosts.
 *
 * Scenario: generic official homepage (decorative only) must not terminate discovery;
 * shop subdomain product page must be selected and give page-scoped Shopify provenance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_SCORE,
  buildOfficialProductPageQueries,
  classifyImageSource,
  classifySourceUrlWithDiscovery,
  discoverOfficialDomains,
  executeImageEnrichment,
  extractExpressionTokensFromHits,
  extractSearchTokens,
  hostMatchesDiscoveredDomain,
  isGenericOfficialPageUrl,
  isProductDetailPageUrl,
  registeredDomain,
  sanitizeJobDiagnostics,
  scoreOfficialProductPage,
  selectBestOfficialProductPage,
  type VisionVerification
} from "./ingestion/enrichment/index.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearEnrichmentSourcesForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  getEnrichmentSource,
  markJobCompleted,
  runImageJob
} from "./ingestion/jobs/index.js";
import { db } from "./db.js";

const UPC = "083664871681";
const HOME = "https://www.thebalvenie.com/";
const PRODUCT_PAGE =
  "https://shop.us.thebalvenie.com/products/the-balvenie-caribbean-cask-14?volume=750%20mL&delivery=null";
const SHOPIFY_HERO =
  "https://cdn.shopify.com/s/files/1/0000/0001/files/Balvenie_Caribbean-Cask.webp";
const GRAIN = "https://cdn.thebalvenie.com/assets/grain_30.png";
const BANNER = "https://cdn.thebalvenie.com/assets/regulatory-banner.png";

function balvenieCandidate() {
  return candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      category: "Scotch Whisky",
      abv: 43,
      volume_ml: 750
    },
    "vault"
  );
}

const HOME_HTML = `
<html><head><title>The Balvenie</title></head>
<body>
  <img src="${GRAIN}" alt="grain texture" width="900" height="900"/>
  <img src="${BANNER}" alt="regulatory banner" width="1200" height="200"/>
</body></html>
`;

const PRODUCT_HTML = `
<html><head>
  <meta property="og:type" content="product"/>
  <meta property="og:title" content="The Balvenie Caribbean Cask 14 Year Old"/>
  <meta property="og:image" content="${SHOPIFY_HERO}?width=1200"/>
  <meta property="og:description" content="Single Malt Scotch Whisky, 43% ABV, 750 mL"/>
  <script type="application/ld+json">
  {
    "@type":"Product",
    "name":"The Balvenie Caribbean Cask 14 Year Old",
    "image":"${SHOPIFY_HERO}",
    "alcoholByVolume":"43%",
    "offers":{"@type":"Offer","price":"79.99","priceCurrency":"USD"},
    "gtin13":"${UPC}"
  }
  </script>
</head><body>
  <h1>The Balvenie Caribbean Cask 14</h1>
  <p>Single Malt Scotch Whisky · 750 mL · Add to cart</p>
</body></html>
`;

function acceptVision(): VisionVerification {
  return {
    correct_product: true,
    bottle_prominent: true,
    contains_people: false,
    meme_or_graphic: false,
    clean_product_photo: true,
    multiple_products: false
  };
}

test("1. generic official homepage does not terminate image product-page discovery", async () => {
  const queries: string[] = [];
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async (query) => {
      queries.push(query);
      if (/^site:/i.test(query)) {
        return [
          {
            title: "The Balvenie Caribbean Cask 14 Year Old",
            content: "Single Malt Scotch Whisky 750 mL",
            url: PRODUCT_PAGE
          }
        ];
      }
      // Broad search only returns generic homepage.
      return [
        {
          title: "The Balvenie Official Site",
          content: "Discover our range of single malt whisky",
          url: HOME
        }
      ];
    },
    fetchPageHtml: async (url) => {
      if (/shop\.us\.thebalvenie\.com\/products/i.test(url)) return PRODUCT_HTML;
      if (/thebalvenie\.com/i.test(url)) return HOME_HTML;
      return null;
    },
    probeImageMeta: async (url) => {
      if (/grain|banner/i.test(url)) {
        return { width: 900, height: 900, mimeType: "image/png", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async () => acceptVision()
  });

  assert.ok(
    queries.some((q) => /^site:thebalvenie\.com/i.test(q)),
    "must run site-scoped product search after domain discovery"
  );
  assert.ok(
    result.diagnostics.stages?.some((s) => s.stage === "official_product_search"),
    "official_product_search diagnostic required"
  );
  assert.equal(
    result.selectedOfficialProductPageUrl?.replace(/\?.*$/, ""),
    PRODUCT_PAGE.replace(/\?.*$/, "")
  );
});

test("2. official commerce subdomain recognized by registered-domain relationship", () => {
  assert.equal(registeredDomain("shop.us.thebalvenie.com"), "thebalvenie.com");
  assert.equal(
    hostMatchesDiscoveredDomain("shop.us.thebalvenie.com", "thebalvenie.com"),
    true
  );
  const discovery = discoverOfficialDomains(
    [{ title: "The Balvenie", url: HOME, content: "official" }],
    { brand: "The Balvenie", name: "Balvenie 14 Yr Carribbean" }
  );
  assert.ok(discovery.domains.includes("thebalvenie.com"));
  assert.equal(
    classifySourceUrlWithDiscovery(PRODUCT_PAGE, {
      brand: "The Balvenie",
      discoveredOfficialDomains: discovery.domains
    }),
    "official"
  );
});

test("3-4. /products/ identity page outranks homepage; title/token matching helps", () => {
  assert.equal(isGenericOfficialPageUrl(HOME), true);
  assert.equal(isProductDetailPageUrl(PRODUCT_PAGE), true);
  const identity = {
    brand: "The Balvenie",
    name: "Balvenie 14 Yr Carribbean",
    upc: UPC
  };
  const homeScore = scoreOfficialProductPage(
    { url: HOME, title: "The Balvenie", content: "Official whisky" },
    identity,
    { discoveredOfficialDomains: ["thebalvenie.com"] }
  );
  const productScore = scoreOfficialProductPage(
    {
      url: PRODUCT_PAGE,
      title: "The Balvenie Caribbean Cask 14 Year Old",
      content: "Single Malt Scotch Whisky"
    },
    identity,
    { discoveredOfficialDomains: ["thebalvenie.com"] }
  );
  assert.ok(productScore.total > homeScore.total);
  assert.ok(productScore.total >= 40);
  assert.ok(productScore.reasons.some((r) => /products_path|title_tokens|path_tokens/.test(r)));

  const selected = selectBestOfficialProductPage(
    [
      { url: HOME, title: "The Balvenie", content: "Home" },
      {
        url: PRODUCT_PAGE,
        title: "The Balvenie Caribbean Cask 14 Year Old",
        content: "750 mL"
      }
    ],
    identity,
    { discoveredOfficialDomains: ["thebalvenie.com"] }
  );
  assert.ok(selected);
  assert.match(selected!.hit.url, /shop\.us\.thebalvenie\.com\/products/i);
});

test("5-6. search typo alias finds Caribbean page; does not mutate persisted identity", async () => {
  const tokens = extractSearchTokens({
    brand: "The Balvenie",
    name: "Balvenie 14 Yr Carribbean",
    upc: UPC
  });
  assert.ok(tokens.productTokens.includes("Caribbean"));
  assert.ok(tokens.productTokensWithAliases.some((t) => /carribbean/i.test(t)));

  const candidate = balvenieCandidate();
  assert.match(candidate.name.value!, /Carribbean/);

  const result = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [],
    searchWebHits: async (query) => {
      if (/site:/i.test(query)) {
        assert.match(query, /Caribbean|083664871681/i);
        return [
          {
            title: "Caribbean Cask 14 | The Balvenie",
            content: "Official product",
            url: PRODUCT_PAGE
          }
        ];
      }
      // Broad tiers use aliased Caribbean in identity queries.
      if (/Caribbean|14 Year|official/i.test(query)) {
        return [{ title: "The Balvenie", content: "Official", url: HOME }];
      }
      return [];
    },
    fetchPageHtml: async (url) =>
      /products/i.test(url) ? PRODUCT_HTML : HOME_HTML,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
      reachable: true
    }),
    verifyImage: async () => acceptVision()
  });

  assert.match(candidate.name.value!, /Carribbean/, "canonical name unchanged");
  assert.ok(result.selectedOfficialProductPageUrl);
});

test("7. selected official product URL appears in diagnostics", async () => {
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async (query) => {
      if (/site:/i.test(query)) {
        return [
          {
            title: "The Balvenie Caribbean Cask 14 Year Old",
            content: "Buy online 750 mL",
            url: PRODUCT_PAGE
          }
        ];
      }
      return [
        { title: "The Balvenie", content: "Official site", url: HOME },
        {
          title: "Caribbean Cask 14",
          content: "The Balvenie Caribbean Cask expression",
          url: PRODUCT_PAGE
        }
      ];
    },
    fetchPageHtml: async (url) =>
      /products/i.test(url) ? PRODUCT_HTML : HOME_HTML,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
      reachable: true
    }),
    verifyImage: async () => acceptVision()
  });

  const stages = sanitizeJobDiagnostics(result.diagnostics).stages ?? [];
  const selected = stages.find((s) => s.stage === "official_product_page_selected");
  assert.ok(selected);
  assert.equal(selected!.status, "ok");
  assert.match(String(selected!.reason ?? ""), /shop\.us\.thebalvenie\.com\/products/i);
  assert.ok(stages.some((s) => s.stage === "official_page_asset"));
});

test("8-11. Shopify page-scoped official provenance; merge; unrelated stays unknown; decorative outranked", async () => {
  assert.equal(
    classifyImageSource(SHOPIFY_HERO, { brand: "The Balvenie" }),
    "unknown",
    "bare Shopify CDN remains unapproved"
  );
  assert.equal(
    classifyImageSource(SHOPIFY_HERO, {
      brand: "The Balvenie",
      pageUrl: PRODUCT_PAGE,
      discoveredOfficialDomains: ["thebalvenie.com"]
    }),
    "official"
  );

  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      { url: SHOPIFY_HERO, sourceUrl: null },
      {
        url: "https://cdn.shopify.com/s/files/1/9999/9999/files/unrelated-rum.webp",
        sourceUrl: null
      }
    ],
    searchWebHits: async (query) => {
      if (/site:/i.test(query)) {
        return [
          {
            title: "The Balvenie Caribbean Cask 14 Year Old",
            content: "Single Malt Scotch Whisky",
            url: PRODUCT_PAGE
          }
        ];
      }
      return [
        { title: "The Balvenie", content: "Home", url: HOME },
        {
          title: "Caribbean Cask",
          content: "The Balvenie Caribbean Cask 14",
          url: PRODUCT_PAGE
        }
      ];
    },
    fetchPageHtml: async (url) =>
      /products/i.test(url) ? PRODUCT_HTML : HOME_HTML,
    probeImageMeta: async (url) => {
      if (/grain|banner/i.test(url)) {
        return { width: 900, height: 400, mimeType: "image/png", reachable: true };
      }
      if (/unrelated/i.test(url)) {
        return { width: 800, height: 800, mimeType: "image/webp", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async ({ imageUrl }) => {
      if (/unrelated|grain|banner/i.test(imageUrl)) {
        return {
          correct_product: false,
          bottle_prominent: true,
          contains_people: false,
          meme_or_graphic: false,
          clean_product_photo: true,
          multiple_products: false
        };
      }
      return acceptVision();
    }
  });

  const hero = result.evaluated.find((c) => /Caribbean-Cask/i.test(c.url));
  assert.ok(hero);
  assert.equal(hero!.sourceType, "official");
  assert.match(String(hero!.sourceUrl ?? ""), /shop\.us\.thebalvenie\.com\/products/i);
  assert.ok((hero!.score ?? 0) >= IMAGE_SCORE.officialSource);

  const unrelated = result.evaluated.find((c) => /unrelated/i.test(c.url));
  if (unrelated) {
    assert.equal(unrelated.sourceType, "unknown");
  }

  const diags = sanitizeJobDiagnostics(result.diagnostics).imageCandidates ?? [];
  const top = diags[0];
  assert.ok(top);
  assert.ok(
    /Caribbean-Cask|shopify/i.test(`${top.urlHost}${top.urlPath}`),
    "product-page bottle image should outrank homepage decorative assets"
  );
  assert.ok(result.selected);
  assert.ok((result.selected!.score ?? 0) >= IMAGE_ACCEPTANCE_THRESHOLD);
});

test("12-15. vision/scoring/threshold/source-trust unchanged", () => {
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.equal(IMAGE_SCORE.officialSource, 40);
  assert.equal(IMAGE_SCORE.exactIdentityMatch, 30);
  assert.equal(IMAGE_SCORE.cleanProductPhoto, 20);
  assert.equal(IMAGE_SCORE.largeImage, 10);
  assert.equal(IMAGE_SCORE.unknownSource, -100);
  // No arbitrary retailer whitelist: Total Wine stays non-official.
  assert.notEqual(
    classifySourceUrlWithDiscovery("https://www.totalwine.com/spirits/balvenie", {
      brand: "The Balvenie",
      discoveredOfficialDomains: ["thebalvenie.com"]
    }),
    "official"
  );
});

test("expression tokens learned from titles for follow-up site query", () => {
  const learned = extractExpressionTokensFromHits(
    [
      {
        url: PRODUCT_PAGE,
        title: "The Balvenie Caribbean Cask 14 Year Old",
        content: "Rum cask finish"
      }
    ],
    {
      brand: "The Balvenie",
      name: "Balvenie 14 Yr Carribbean",
      upc: UPC
    }
  );
  assert.ok(learned.some((t) => /cask/i.test(t)));
  const queries = buildOfficialProductPageQueries(
    {
      brand: "The Balvenie",
      name: "Balvenie 14 Yr Carribbean",
      upc: UPC
    },
    ["thebalvenie.com"],
    learned
  );
  assert.ok(queries.some((q) => /site:thebalvenie\.com/i.test(q.query)));
  assert.ok(queries.some((q) => /Cask/i.test(q.query)));
});

test("16-17. patrons lack diagnostics; scan-session untouched smoke via job persist", async () => {
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  clearEnrichmentSourcesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc = ?`).run(UPC);
  const inserted = db
    .prepare(
      `INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, upc, image_url)
       VALUES (?, ?, 'Whiskey', 'Scotch Whisky', 43, 750, ?, '')`
    )
    .run("Balvenie 14 Yr Carribbean", "The Balvenie", UPC);
  const id = Number(inserted.lastInsertRowid);
  enqueueImageJob({ entityType: "spirits", entityId: id, upc: UPC });
  const claimed = db
    .prepare(
      `SELECT * FROM enrichment_jobs WHERE entity_type='spirits' AND entity_id=? AND job_type='image' LIMIT 1`
    )
    .get(id) as { id: number };

  const run = await runImageJob(claimed as never, {
    searchImageHits: async () => [{ url: SHOPIFY_HERO, sourceUrl: null }],
    searchWebHits: async (query: string) => {
      if (/site:/i.test(query)) {
        return [
          {
            title: "The Balvenie Caribbean Cask 14 Year Old",
            content: "Product",
            url: PRODUCT_PAGE
          }
        ];
      }
      return [{ title: "The Balvenie", content: "Home", url: HOME }];
    },
    fetchPageHtml: async (url: string) =>
      /products/i.test(url) ? PRODUCT_HTML : HOME_HTML,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
      reachable: true
    }),
    verifyImage: async () => acceptVision()
  } as never);
  markJobCompleted(claimed.id, run.resultPayload);

  const stored = getEnrichmentSource("spirits", id, "official_product_page");
  assert.ok(stored);
  assert.match(stored!.sourceUrl, /shop\.us\.thebalvenie\.com\/products/i);

  const keeper = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  })!;
  assert.ok(
    keeper.enrichment.jobs
      .find((j) => j.type === "image")
      ?.diagnostics?.stages?.some((s) => s.stage === "official_product_page_selected")
  );

  const patron = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: false
  })!;
  assert.equal(patron.enrichment.jobs.find((j) => j.type === "image")?.diagnostics, undefined);

  // Canonical name still misspelled in inventory.
  const row = db.prepare(`SELECT name FROM spirits WHERE id=?`).get(id) as { name: string };
  assert.match(row.name, /Carribbean/);

  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  clearEnrichmentSourcesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc = ?`).run(UPC);
});
