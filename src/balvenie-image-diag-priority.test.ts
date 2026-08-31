/**
 * Image diagnostics prioritization + official provenance merge (Balvenie).
 * Fakes only — no live Ollama / SearXNG / external hosts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_SCORE,
  classifyImageSource,
  executeImageEnrichment,
  mergeImageSeedsByNormalizedUrl,
  normalizeImageUrlForDedupe,
  prioritizeImageCandidateDiagnostics,
  sanitizeJobDiagnostics,
  type ImageCandidateDiagnostic,
  type VisionVerification
} from "./ingestion/enrichment/index.js";
import {
  buildBottleEnrichmentView,
  clearEnrichmentJobsForTests,
  clearProductImagesForTests,
  enqueueImageJob,
  markJobCompleted,
  runImageJob
} from "./ingestion/jobs/index.js";
import { db } from "./db.js";

const UPC = "083664871681";
const OFFICIAL_PAGE = "https://www.thebalvenie.com/en-us/range/caribbean-cask";
const SHOPIFY_ASSET =
  "https://cdn.shopify.com/s/files/1/0000/0001/files/Balvenie_750ML_CC14_1.webp";

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

function visionReject(url: string): VisionVerification {
  if (/hero/i.test(url)) {
    return {
      correct_product: true,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    };
  }
  if (/lifestyle/i.test(url)) {
    return {
      correct_product: true,
      bottle_prominent: false,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    };
  }
  if (/doublewood/i.test(url)) {
    return {
      correct_product: false,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    };
  }
  return {
    correct_product: false,
    bottle_prominent: true,
    contains_people: false,
    meme_or_graphic: false,
    clean_product_photo: false,
    multiple_products: false
  };
}

function fakeDiag(overrides: Partial<ImageCandidateDiagnostic>): ImageCandidateDiagnostic {
  return {
    urlHost: "cdn.example.com",
    urlPath: "…/x.jpg",
    sourceType: "unknown",
    accepted: false,
    rejectionReasons: ["unapproved_source"],
    stageReached: "hard_filter",
    ...overrides
  };
}

test("1-2. verification-stage candidates outrank search junk in bounded diagnostics", () => {
  const junk = Array.from({ length: 10 }, (_, i) =>
    fakeDiag({
      urlHost: `junk${i}.example.com`,
      urlPath: `…/ad-${i}.jpg`,
      sourceType: "unknown",
      stageReached: "hard_filter",
      rejectionReasons: ["unapproved_source"]
    })
  );
  const official = Array.from({ length: 4 }, (_, i) =>
    fakeDiag({
      urlHost: "cdn.thebalvenie.com",
      urlPath: `…/official-${i}.jpg`,
      sourceType: "official",
      stageReached: "verification",
      vision: {
        ran: true,
        correctProduct: false,
        bottleProminent: true,
        cleanProductPhoto: true
      },
      rejectionReasons: ["wrong_product"],
      score: 40,
      threshold: 75
    })
  );
  const bound = prioritizeImageCandidateDiagnostics([...junk, ...official], 6);
  assert.equal(bound.length, 6);
  const officialKept = bound.filter((d) => d.sourceType === "official");
  assert.equal(officialKept.length, 4, "all 4 official verification candidates must remain");
  assert.ok(bound.every((d, i) => i < 4 || d.sourceType === "unknown"));
});

test("3-4. verification rejection includes exact reason; stageReached correct", async () => {
  const officialUrls = [
    "https://cdn.thebalvenie.com/products/caribbean-cask-lifestyle.jpg",
    "https://cdn.thebalvenie.com/products/doublewood-12-bottle.jpg",
    "https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg",
    "https://cdn.thebalvenie.com/products/caribbean-cask-alt.jpg"
  ];
  const searchJunk = Array.from({ length: 8 }, (_, i) => ({
    url: `https://www.totalwine.com/media/balvenie-ad-${i}.jpg`,
    sourceUrl: null as string | null
  }));

  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      ...searchJunk,
      ...officialUrls.map((url) => ({ url, sourceUrl: OFFICIAL_PAGE }))
    ],
    searchWebHits: async () => [],
    probeImageMeta: async (url) => {
      if (/totalwine/i.test(url)) {
        return { width: 900, height: 900, mimeType: "image/jpeg", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async ({ imageUrl }) => {
      if (/lifestyle/i.test(imageUrl)) {
        return {
          correct_product: true,
          bottle_prominent: false,
          contains_people: false,
          meme_or_graphic: false,
          clean_product_photo: true,
          multiple_products: false
        };
      }
      return {
        correct_product: false,
        bottle_prominent: true,
        contains_people: false,
        meme_or_graphic: false,
        clean_product_photo: true,
        multiple_products: false
      };
    }
  });

  const sanitized = sanitizeJobDiagnostics(result.diagnostics);
  const diags = sanitized.imageCandidates ?? [];
  const verification = diags.filter(
    (d) =>
      d.stageReached === "verification"
      || d.stageReached === "scoring"
      || d.stageReached === "accepted"
      || d.vision?.ran
  );
  assert.ok(verification.length >= 1, "verification-stage rows must be present");
  assert.ok(
    verification.every((d) => d.accepted || d.rejectionReasons.length > 0),
    "every verification candidate needs an exact reason"
  );
  assert.ok(
    verification.some((d) => d.sourceType === "official"),
    "official verification candidates remain visible after bounding"
  );
  assert.equal(result.selected, null);
  assert.match(String(sanitized.summary ?? ""), /verification|official|candidate|rejected/i);
  assert.ok(
    verification.some((d) =>
      d.rejectionReasons.some((r) =>
        ["wrong_product", "bottle_not_prominent"].includes(r)
      )
    )
  );
});

test("5-8. duplicate search+official Shopify asset keeps official provenance; CDN not global", () => {
  assert.equal(
    classifyImageSource(SHOPIFY_ASSET, { brand: "The Balvenie" }),
    "unknown",
    "search-only Shopify remains unapproved"
  );
  assert.equal(
    classifyImageSource(SHOPIFY_ASSET, {
      brand: "The Balvenie",
      pageUrl: OFFICIAL_PAGE
    }),
    "official",
    "official-page-referenced Shopify asset is page-scoped official"
  );

  const merged = mergeImageSeedsByNormalizedUrl([
    { url: `${SHOPIFY_ASSET}?v=111`, sourceUrl: null },
    { url: `${SHOPIFY_ASSET}?v=222`, sourceUrl: OFFICIAL_PAGE }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceUrl, OFFICIAL_PAGE);
  assert.equal(
    normalizeImageUrlForDedupe(`${SHOPIFY_ASSET}?v=111`),
    normalizeImageUrlForDedupe(`${SHOPIFY_ASSET}?v=999`)
  );

  // End-to-end: weaker search discovery first, then official page reference.
  return executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      { url: `${SHOPIFY_ASSET}?v=1`, sourceUrl: null },
      {
        url: "https://www.totalwine.com/media/other.jpg",
        sourceUrl: null
      }
    ],
    searchWebHits: async () => [
      { title: "Caribbean Cask", content: "Official", url: OFFICIAL_PAGE }
    ],
    fetchPageHtml: async () => `
      <html><head>
        <meta property="og:image" content="${SHOPIFY_ASSET}?v=2"/>
      </head></html>
    `,
    probeImageMeta: async (url) => {
      if (/totalwine/i.test(url)) {
        return { width: 800, height: 800, mimeType: "image/jpeg", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async () => ({
      correct_product: true,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    })
  }).then((result) => {
    const shopify = result.evaluated.find((c) => /shopify/i.test(c.url));
    assert.ok(shopify);
    assert.equal(shopify!.sourceType, "official");
    assert.ok((shopify!.score ?? 0) >= IMAGE_SCORE.officialSource);
    const diag = result.diagnostics.imageCandidates?.find((d) => /shopify/i.test(d.urlHost));
    assert.ok(diag);
    assert.equal(diag!.sourceType, "official");
  });
});

test("9-11. threshold 75, weights and vision rules unchanged", () => {
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.equal(IMAGE_SCORE.officialSource, 40);
  assert.equal(IMAGE_SCORE.exactIdentityMatch, 30);
  assert.equal(IMAGE_SCORE.cleanProductPhoto, 20);
  assert.equal(IMAGE_SCORE.largeImage, 10);
});

test("12-13. patrons do not receive diagnostics; metadata path untouched smoke", async () => {
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
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
    searchImageHits: async () => [
      { url: "https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg", sourceUrl: OFFICIAL_PAGE }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => ({
      correct_product: true,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    })
  } as never);
  markJobCompleted(claimed.id, run.resultPayload);

  const keeper = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  })!;
  assert.ok(keeper.enrichment.jobs.find((j) => j.type === "image")?.diagnostics?.imageCandidates?.length);

  const patron = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: false
  })!;
  assert.equal(patron.enrichment.jobs.find((j) => j.type === "image")?.diagnostics, undefined);

  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc = ?`).run(UPC);
});

test("14. bounded fixture: 8 junk + 4 official verification always keeps official rows", async () => {
  const official = [
    "https://cdn.thebalvenie.com/products/caribbean-cask-lifestyle.jpg",
    "https://cdn.thebalvenie.com/products/doublewood-12-bottle.jpg",
    "https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg",
    "https://cdn.thebalvenie.com/products/caribbean-cask-extra.jpg"
  ];
  const junk = Array.from({ length: 8 }, (_, i) => ({
    url: `https://retailer.example/ad-${i}.jpg?utm_source=x`,
    sourceUrl: null as string | null
  }));

  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      ...junk,
      ...official.map((url) => ({ url, sourceUrl: OFFICIAL_PAGE }))
    ],
    searchWebHits: async () => [],
    probeImageMeta: async (url) => {
      if (/retailer\.example/i.test(url)) {
        const reachable = !/ad-0|ad-1/.test(url);
        return { width: 700, height: 700, mimeType: "image/jpeg", reachable };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async ({ imageUrl }) => visionReject(imageUrl)
  });

  const diags = sanitizeJobDiagnostics(result.diagnostics).imageCandidates ?? [];
  const officialVerification = diags.filter(
    (d) =>
      d.sourceType === "official"
      && (d.stageReached === "verification"
        || d.stageReached === "scoring"
        || d.stageReached === "accepted"
        || d.vision?.ran)
  );
  assert.ok(
    officialVerification.length >= 1,
    "official verification candidates must appear in bounded diagnostics"
  );
  assert.ok(
    officialVerification.every((d) => d.accepted || d.rejectionReasons.length > 0)
  );
});
