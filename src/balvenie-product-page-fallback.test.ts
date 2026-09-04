/**
 * Official product-page discovery fallback (Balvenie).
 * site: queries may return zero on some SearXNG engines — broad search +
 * code-side registered-domain filter + bounded sitemap must still find the page.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_SCORE,
  buildOfficialProductPageBroadQueries,
  classifyImageSource,
  classifySourceUrlWithDiscovery,
  discoverOfficialProductUrlsFromSite,
  executeImageEnrichment,
  extractExpressionTokensFromHits,
  extractSearchTokens,
  filterHitsByOfficialRegisteredDomain,
  preferredProductPhrase,
  sanitizeJobDiagnostics,
  type VisionVerification
} from "./ingestion/enrichment/index.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearEnrichmentSourcesForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  markJobCompleted,
  runImageJob
} from "./ingestion/jobs/index.js";
import { db } from "./db.js";

const UPC = "083664871681";
const HOME = "https://www.thebalvenie.com/";
const PRODUCT_PAGE =
  "https://shop.us.thebalvenie.com/products/the-balvenie-caribbean-cask-14";
const SHOPIFY_HERO =
  "https://cdn.shopify.com/s/files/1/0000/0001/files/Balvenie_Caribbean-Cask.webp";

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

const PRODUCT_HTML = `
<html><head>
  <meta property="og:type" content="product"/>
  <meta property="og:image" content="${SHOPIFY_HERO}?width=1200"/>
  <script type="application/ld+json">
  {"@type":"Product","name":"The Balvenie Caribbean Cask 14 Year Old","image":"${SHOPIFY_HERO}","gtin13":"${UPC}","offers":{"price":"79"}}
  </script>
</head><body><h1>Caribbean Cask 14</h1></body></html>
`;

const HOME_HTML = `<html><head><title>The Balvenie</title></head><body>Home</body></html>`;

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

test("1-5. site: zero does not terminate; broad fallback + domain filter + ranking", async () => {
  const queries: string[] = [];
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async (query) => {
      queries.push(query);
      // Domain-restricted search always empty (SearXNG site: unsupported).
      if (/^site:/i.test(query)) return [];
      // Initial page ladder tiers (bottle / official) only surface the homepage.
      if (/\bbottle\b/i.test(query) || /\bofficial\b/i.test(query)) {
        return [{ title: "The Balvenie", content: "Official whisky", url: HOME }];
      }
      // Broad product-page fallback returns mix: retailer, junk, official commerce PDP.
      if (/Caribbean/i.test(query) || /Cask/i.test(query)) {
        return [
          {
            title: "Balvenie 14 at Total Wine",
            content: "Buy online",
            url: "https://www.totalwine.com/spirits/balvenie-14"
          },
          {
            title: "Unrelated image host",
            content: "photo",
            url: "https://images.example/balvenie.jpg"
          },
          {
            title: "The Balvenie Caribbean Cask 14 Year Old",
            content: "Single Malt Scotch Whisky 750 mL",
            url: PRODUCT_PAGE
          }
        ];
      }
      return [{ title: "The Balvenie", content: "Home", url: HOME }];
    },
    fetchPageHtml: async (url) => {
      if (/products/i.test(url)) return PRODUCT_HTML;
      if (/thebalvenie\.com/i.test(url)) return HOME_HTML;
      return null;
    },
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
      reachable: true
    }),
    verifyImage: async () => acceptVision()
  });

  assert.ok(queries.some((q) => /^site:/i.test(q)), "optional site: tier still attempted");
  assert.ok(
    queries.some((q) => !/^site:/i.test(q) && /Caribbean/i.test(q) && !/\bbottle\b/i.test(q)),
    "broad fallback must run"
  );
  const stages = sanitizeJobDiagnostics(result.diagnostics).stages ?? [];
  assert.ok(stages.some((s) => s.stage === "official_product_search_broad"));
  assert.ok(stages.some((s) => s.stage === "official_domain_filter" && s.status === "ok"));
  const selected = stages.find((s) => s.stage === "official_product_page_selected");
  assert.equal(selected?.status, "ok");
  assert.match(String(selected?.reason ?? ""), /shop\.us\.thebalvenie\.com\/products/i);
  assert.match(result.selectedOfficialProductPageUrl ?? "", /caribbean-cask-14/i);

  // Retailer rejected by domain filter / ranking.
  const retailerKept = filterHitsByOfficialRegisteredDomain(
    [{ url: "https://www.totalwine.com/spirits/balvenie-14", title: "x" }],
    ["thebalvenie.com"]
  );
  assert.equal(retailerKept.length, 0);
  const shopKept = filterHitsByOfficialRegisteredDomain(
    [{ url: PRODUCT_PAGE, title: "Caribbean Cask 14" }],
    ["thebalvenie.com"]
  );
  assert.equal(shopKept.length, 1);
});

test("6-8. learned Cask token; identity unchanged; 14 Yr retrieval variants", () => {
  const identity = {
    brand: "The Balvenie",
    name: "Balvenie 14 Yr Carribbean",
    upc: UPC
  };
  const tokens = extractSearchTokens(identity);
  assert.ok(tokens.productTokens.includes("14"), "age numeral retained");
  assert.ok(tokens.productTokens.includes("Year") || tokens.productTokens.includes("Yr"));
  assert.ok(tokens.productTokens.includes("Caribbean"));
  const phrase = preferredProductPhrase(identity);
  assert.match(phrase, /14/);
  assert.match(phrase, /Caribbean/i);
  assert.ok(!/Yr Year/i.test(phrase), "preferred phrase should not duplicate Yr+Year");

  const learned = extractExpressionTokensFromHits(
    [
      {
        url: PRODUCT_PAGE,
        title: "The Balvenie Caribbean Cask 14 Year Old",
        content: "Rum cask finish"
      }
    ],
    identity
  );
  assert.ok(learned.some((t) => /cask/i.test(t)));
  const broad = buildOfficialProductPageBroadQueries(identity, learned);
  assert.ok(broad.some((q) => /Cask/i.test(q.query)));
  assert.ok(broad.every((q) => !/^site:/i.test(q.query)));

  const candidate = balvenieCandidate();
  assert.match(candidate.name.value!, /Carribbean/);
});

test("9. known official domain + no product page diagnosed distinctly", async () => {
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async (query) => {
      if (/^site:/i.test(query)) return [];
      // Only homepage — never a product URL.
      return [{ title: "The Balvenie", content: "Official", url: HOME }];
    },
    fetchPageHtml: async (url) => {
      if (/robots\.txt|sitemap/i.test(url)) return null;
      return HOME_HTML;
    },
    probeImageMeta: async () => ({
      width: 800,
      height: 800,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => acceptVision()
  });

  const selected = result.diagnostics.stages?.find(
    (s) => s.stage === "official_product_page_selected"
  );
  assert.equal(selected?.status, "no_result");
  assert.equal(selected?.reason, "official_domain_known_but_no_product_page");
  assert.notEqual(selected?.reason, "no_official_domain");
});

test("10-11. bounded sitemap discovery finds same-domain product; rejects unrelated", async () => {
  const sitemapXml = `<?xml version="1.0"?>
  <urlset>
    <url><loc>${HOME}</loc></url>
    <url><loc>${PRODUCT_PAGE}</loc></url>
    <url><loc>https://evil.example/products/fake-balvenie</loc></url>
  </urlset>`;

  const discovered = await discoverOfficialProductUrlsFromSite({
    trustedDomains: ["thebalvenie.com"],
    knownHosts: ["shop.us.thebalvenie.com", "www.thebalvenie.com"],
    identity: {
      brand: "The Balvenie",
      name: "Balvenie 14 Yr Carribbean",
      upc: UPC
    },
    fetchText: async (url) => {
      if (/evil\.example/i.test(url)) {
        assert.fail("must not fetch unrelated domain");
      }
      if (/robots\.txt/i.test(url)) {
        return "User-agent: *\nSitemap: https://shop.us.thebalvenie.com/sitemap.xml\n";
      }
      if (/sitemap/i.test(url)) return sitemapXml;
      if (/thebalvenie\.com\/?$/i.test(url) || /thebalvenie\.com\/$/i.test(url)) {
        return `<html><a href="/products/the-balvenie-caribbean-cask-14">Cask</a></html>`;
      }
      return null;
    }
  });

  assert.ok(discovered.urls.some((u) => /caribbean-cask-14/i.test(u.url)));
  assert.ok(discovered.urls.every((u) => /thebalvenie\.com/i.test(u.url)));
  assert.ok(!discovered.urls.some((u) => /evil\.example/i.test(u.url)));

  // End-to-end: search finds no PDP; sitemap does.
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async (query) => {
      if (/^site:/i.test(query)) return [];
      return [{ title: "The Balvenie", content: "Home", url: HOME }];
    },
    fetchPageHtml: async (url) => {
      if (/robots\.txt/i.test(url)) {
        return "Sitemap: https://www.thebalvenie.com/sitemap.xml\n";
      }
      if (/sitemap\.xml/i.test(url)) return sitemapXml;
      if (/products/i.test(url)) return PRODUCT_HTML;
      return HOME_HTML;
    },
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
      reachable: true
    }),
    verifyImage: async () => acceptVision()
  });

  assert.ok(
    result.diagnostics.stages?.some(
      (s) => s.stage === "official_sitemap_discovery" && s.status === "ok"
    )
  );
  assert.match(result.selectedOfficialProductPageUrl ?? "", /caribbean-cask-14/i);
});

test("12-15. Shopify page-scoped only; threshold/weights/vision unchanged", async () => {
  assert.equal(
    classifyImageSource(SHOPIFY_HERO, { brand: "The Balvenie" }),
    "unknown"
  );
  assert.equal(
    classifyImageSource(SHOPIFY_HERO, {
      brand: "The Balvenie",
      pageUrl: PRODUCT_PAGE,
      discoveredOfficialDomains: ["thebalvenie.com"]
    }),
    "official"
  );
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.equal(IMAGE_SCORE.officialSource, 40);
  assert.equal(IMAGE_SCORE.exactIdentityMatch, 30);
  assert.equal(IMAGE_SCORE.cleanProductPhoto, 20);
  assert.equal(IMAGE_SCORE.largeImage, 10);
  assert.notEqual(
    classifySourceUrlWithDiscovery("https://www.totalwine.com/x", {
      brand: "The Balvenie",
      discoveredOfficialDomains: ["thebalvenie.com"]
    }),
    "official"
  );
});

test("16. patrons do not receive diagnostics", async () => {
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
    searchImageHits: async () => [],
    searchWebHits: async (query: string) => {
      if (/^site:/i.test(query)) return [];
      if (/\bbottle\b/i.test(query) || /\bofficial\b/i.test(query)) {
        return [{ title: "The Balvenie", content: "Home", url: HOME }];
      }
      if (/Caribbean|Cask/i.test(query)) {
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
    verifyImage: async () => acceptVision(),
    localizeImage: async () => "/api/media/images/balvenie-fallback-localized.jpg"
  } as never);
  markJobCompleted(claimed.id, run.resultPayload);

  const keeper = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  })!;
  assert.ok(
    keeper.enrichment.jobs
      .find((j) => j.type === "image")
      ?.diagnostics?.stages?.some((s) => s.stage === "official_product_search_broad")
  );
  const patron = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: false
  })!;
  assert.equal(patron.enrichment.jobs.find((j) => j.type === "image")?.diagnostics, undefined);

  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  clearEnrichmentSourcesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc = ?`).run(UPC);
});
