/**
 * Image diagnostic lifecycle: stable candidate IDs, cap-after-verification,
 * official provenance merge, CSS non-image filter (Balvenie).
 * Fakes only — no live Ollama / SearXNG / external hosts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_MAX_VISION_CHECKS,
  IMAGE_SCORE,
  ImageCandidateDiagnosticStore,
  checkVerificationDiagnosticConsistency,
  executeImageEnrichment,
  extractCssBackgroundUrls,
  imageCandidateIdFromUrl,
  isNonImageAssetUrl,
  mergeImageSeedsByNormalizedUrl,
  normalizeImageUrlForDedupe,
  orderSeedsForProbe,
  prioritizeImageCandidateDiagnostics,
  sanitizeJobDiagnostics,
  type ImageCandidateDiagnostic,
  type VisionVerification
} from "./ingestion/enrichment/index.js";

const UPC = "083664871681";
const OFFICIAL_PAGE = "https://www.thebalvenie.com/en-us/range/caribbean-cask";
const SHOPIFY_PRODUCT =
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

function isVerificationStage(d: ImageCandidateDiagnostic): boolean {
  return (
    d.stageReached === "verification"
    || d.stageReached === "scoring"
    || d.stageReached === "accepted"
    || Boolean(d.vision?.ran)
  );
}

function visionFor(url: string): VisionVerification {
  if (/bottle-a|bottle-b|bottle-c|bottle-d|Caribbean-Cask/i.test(url)) {
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
  return {
    correct_product: false,
    bottle_prominent: true,
    contains_people: false,
    meme_or_graphic: false,
    clean_product_photo: true,
    multiple_products: false
  };
}

test("1. diagnostic cap applied after verification updates (not insertion order)", () => {
  const store = new ImageCandidateDiagnosticStore();
  // Insert 10 junk rows first (would fill a premature cap).
  for (let i = 0; i < 10; i++) {
    store.markHardFilter({
      url: `https://junk.example/ad-${i}.jpg`,
      sourceType: "unknown",
      reasons: ["unapproved_source"]
    });
  }
  // Later: four verification updates on distinct bottle URLs.
  for (let i = 0; i < 4; i++) {
    const url = `https://cdn.thebalvenie.com/products/bottle-${i}.webp`;
    store.markVerificationStarted({
      url,
      sourceType: "official",
      sourceUrl: OFFICIAL_PAGE,
      width: 1200,
      height: 1600
    });
    store.markVerificationResult({
      url,
      sourceType: "official",
      sourceUrl: OFFICIAL_PAGE,
      width: 1200,
      height: 1600,
      vision: visionFor(url),
      score: 100,
      accepted: false,
      rejectionReasons: ["wrong_product"],
      stageReached: "verification"
    });
  }
  assert.equal(store.size(), 14, "working map retains all rows before cap");
  const bounded = store.toBoundedList(12);
  assert.equal(bounded.length, 12);
  const verification = bounded.filter(isVerificationStage);
  assert.equal(verification.length, 4, "cap must keep all verification rows");
  assert.ok(bounded.slice(0, 4).every(isVerificationStage));
});

test("2-4. four sent-to-vision → four verification diags; outrank decorative + junk", async () => {
  const bottles = [
    "https://cdn.thebalvenie.com/products/bottle-a-caribbean.webp",
    "https://cdn.thebalvenie.com/products/bottle-b-caribbean.webp",
    "https://cdn.thebalvenie.com/products/bottle-c-caribbean.webp",
    "https://cdn.thebalvenie.com/products/bottle-d-caribbean.webp"
  ];
  const decorative = [
    "https://cdn.thebalvenie.com/assets/grain-texture.jpg",
    "https://cdn.thebalvenie.com/assets/regulatory-banner.jpg"
  ];
  const junk = Array.from({ length: 8 }, (_, i) => ({
    url: `https://retailer.example/search-junk-${i}.jpg`,
    sourceUrl: null as string | null
  }));

  const visionCalls: string[] = [];
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      ...junk,
      ...decorative.map((url) => ({ url, sourceUrl: OFFICIAL_PAGE })),
      ...bottles.map((url) => ({ url, sourceUrl: OFFICIAL_PAGE }))
    ],
    searchWebHits: async () => [],
    probeImageMeta: async (url) => {
      if (/retailer\.example|grain|banner/i.test(url)) {
        return { width: 900, height: 900, mimeType: "image/jpeg", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async ({ imageUrl }) => {
      visionCalls.push(imageUrl);
      // Reject all so we exercise full vision budget without early accept.
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
  const verification = diags.filter(isVerificationStage);

  const hardFilterAccepted =
    sanitized.stages?.find((s) => s.stage === "hard_filter")?.acceptedCount ?? 0;
  assert.ok(hardFilterAccepted >= 4, "at least four bottles reach vision queue");

  // Working (pre-sanitize) list must contain one verification-stage row per queue member.
  const workingVerification = (result.diagnostics.imageCandidates ?? []).filter(isVerificationStage);
  assert.equal(
    workingVerification.length,
    hardFilterAccepted,
    "four sent-to-vision (queue) produce four verification-stage diagnostics"
  );

  // Bounded list still keeps verification rows ahead of decorative/junk.
  assert.ok(verification.length >= Math.min(4, hardFilterAccepted, 12));
  const bottleVerification = verification.filter((d) => /bottle-[a-d]/i.test(d.urlPath || ""));
  assert.ok(bottleVerification.length >= Math.min(4, IMAGE_MAX_VISION_CHECKS));
  assert.ok(diags.slice(0, bottleVerification.length).every(isVerificationStage));
  assert.ok(
    !diags.slice(0, bottleVerification.length).some((d) => /grain|banner|junk/i.test(d.urlPath || ""))
  );

  for (const d of workingVerification) {
    assert.ok(d.vision?.ran, "every verification candidate records vision ran");
    assert.ok(
      d.vision?.correctProduct != null || d.vision?.error,
      "vision structured result or provider/parse error"
    );
    assert.ok(d.accepted || (d.rejectionReasons?.length ?? 0) > 0);
  }

  const consistency = checkVerificationDiagnosticConsistency({
    verificationCountFromStages:
      sanitized.stages?.find((s) => s.stage === "verify")?.candidateCount ?? 0,
    diagnostics: result.diagnostics.imageCandidates ?? []
  });
  assert.equal(consistency.ok, true);
  assert.equal(consistency.reason, null);
  assert.ok(visionCalls.length >= Math.min(IMAGE_MAX_VISION_CHECKS, hardFilterAccepted));
});

test("5-7. vision structured result, score, and exact rejection persist in result_json", async () => {
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      {
        url: "https://cdn.thebalvenie.com/products/caribbean-lifestyle.jpg",
        sourceUrl: OFFICIAL_PAGE
      }
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
      bottle_prominent: false,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    })
  });

  const diags = sanitizeJobDiagnostics(result.diagnostics).imageCandidates ?? [];
  const row = diags.find((d) => d.vision?.ran);
  assert.ok(row);
  assert.equal(row!.vision!.correctProduct, true);
  assert.equal(row!.vision!.bottleProminent, false);
  assert.equal(row!.vision!.cleanProductPhoto, true);
  assert.ok(typeof row!.score === "number");
  assert.ok(row!.rejectionReasons.includes("bottle_not_prominent"));
  assert.equal(row!.threshold, 75);
});

test("8. candidate ID remains stable through pipeline stages", () => {
  const url = `${SHOPIFY_PRODUCT}?width=1200`;
  const id = imageCandidateIdFromUrl(url);
  const store = new ImageCandidateDiagnosticStore();
  store.ensureDiscovered({
    url,
    sourceType: "unknown"
  });
  store.markHardFilter({
    url,
    sourceType: "official",
    sourceUrl: OFFICIAL_PAGE,
    reasons: ["unapproved_source"]
  });
  // Upgrade path: same id advances to verification (monotonic stage).
  store.markVerificationStarted({
    url,
    sourceType: "official",
    sourceUrl: OFFICIAL_PAGE,
    width: 1200,
    height: 1600
  });
  store.markVerificationResult({
    url,
    sourceType: "official",
    sourceUrl: OFFICIAL_PAGE,
    width: 1200,
    height: 1600,
    vision: visionFor(url),
    score: 100,
    accepted: false,
    rejectionReasons: ["wrong_product"],
    stageReached: "verification"
  });
  assert.equal(store.size(), 1, "same record updated — no duplicate rows");
  const row = store.get(id)!;
  assert.equal(row.candidateId, id);
  assert.equal(row.stageReached, "verification");
  assert.equal(row.sourceType, "official");
  assert.equal(row.vision?.ran, true);
  assert.equal(row.score, 100);
});

test("9. Shopify search + official-page duplicate upgrades provenance when keys match", async () => {
  assert.equal(
    normalizeImageUrlForDedupe(SHOPIFY_PRODUCT),
    normalizeImageUrlForDedupe(`${SHOPIFY_PRODUCT}?width=1200`)
  );
  const merged = mergeImageSeedsByNormalizedUrl([
    { url: SHOPIFY_PRODUCT, sourceUrl: null },
    { url: `${SHOPIFY_PRODUCT}?width=1200`, sourceUrl: OFFICIAL_PAGE }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceUrl, OFFICIAL_PAGE);

  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [{ url: SHOPIFY_PRODUCT, sourceUrl: null }],
    searchWebHits: async () => [
      { title: "Caribbean Cask", content: "Official", url: OFFICIAL_PAGE }
    ],
    fetchPageHtml: async () => `
      <html><head>
        <meta property="og:image" content="${SHOPIFY_PRODUCT}?width=1200"/>
      </head></html>
    `,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
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
  });

  const shopify = result.evaluated.find((c) => /shopify/i.test(c.url));
  assert.ok(shopify);
  assert.equal(shopify!.sourceType, "official");
  assert.ok((shopify!.score ?? 0) >= IMAGE_SCORE.officialSource + IMAGE_SCORE.exactIdentityMatch);
  const diag = result.diagnostics.imageCandidates?.find((d) => /shopify/i.test(d.urlHost));
  assert.ok(diag);
  assert.equal(diag!.sourceType, "official");
  assert.ok(result.diagnostics.stages?.some((s) => s.stage === "official_page_asset"));
});

test("10. official-page distinct variant remains independently visible if keys differ", () => {
  const a = "https://cdn.shopify.com/s/files/1/0000/0001/files/product-front.webp";
  const b = "https://cdn.shopify.com/s/files/1/0000/0001/files/product-front-1200.webp";
  assert.notEqual(normalizeImageUrlForDedupe(a), normalizeImageUrlForDedupe(b));
  const merged = mergeImageSeedsByNormalizedUrl([
    { url: a, sourceUrl: null },
    { url: b, sourceUrl: OFFICIAL_PAGE }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((s) => s.url === b)?.sourceUrl, OFFICIAL_PAGE);
});

test("FWGS ccstore source= is asset identity — F1 475 and F1 1200 dedupe", () => {
  const f1_475 =
    "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_1003007_F1.jpg&height=475&width=475";
  const f1_1200 =
    "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_1003007_F1.jpg&height=1200&width=1200";
  assert.equal(normalizeImageUrlForDedupe(f1_475), normalizeImageUrlForDedupe(f1_1200));
  assert.equal(imageCandidateIdFromUrl(f1_475), imageCandidateIdFromUrl(f1_1200));
  assert.match(normalizeImageUrlForDedupe(f1_475), /source=/);
  assert.doesNotMatch(normalizeImageUrlForDedupe(f1_475), /height=|width=/);
});

test("FWGS ccstore source= keeps F1 and B1 as distinct candidates", () => {
  const f1 =
    "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_1003007_F1.jpg&height=475&width=475";
  const b1 =
    "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_1003007_B1.jpg&height=475&width=475";
  assert.notEqual(normalizeImageUrlForDedupe(f1), normalizeImageUrlForDedupe(b1));
  assert.notEqual(imageCandidateIdFromUrl(f1), imageCandidateIdFromUrl(b1));
});

test("FWGS ccstore source= keeps different PLCB assets distinct", () => {
  const captain =
    "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=1200&width=1200";
  const gilbeys =
    "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000005295_F1.jpg&height=1200&width=1200";
  assert.notEqual(normalizeImageUrlForDedupe(captain), normalizeImageUrlForDedupe(gilbeys));
});

test("non-FWGS source= tracking param continues to strip", () => {
  const withTracking = "https://example.com/image.jpg?source=google&utm_campaign=x";
  const bare = "https://example.com/image.jpg";
  assert.equal(normalizeImageUrlForDedupe(withTracking), bare);
});

test("11. stylesheet URL itself is not treated as image candidate", async () => {
  assert.equal(
    isNonImageAssetUrl("https://cdn.thebalvenie.com/cdn/shop/t/12/assets/theme.css"),
    true
  );
  const fromCss = extractCssBackgroundUrls(
    `
    @font-face { src: url("/fonts/x.woff2"); }
    .hero { background-image: url("/images/bottle-hero.webp"); }
    `,
    "https://cdn.thebalvenie.com/assets/theme.css"
  );
  assert.ok(fromCss.every((u) => !/\.css(\?|$)/i.test(u)));
  assert.ok(fromCss.some((u) => /bottle-hero\.webp/i.test(u)));
  assert.ok(!fromCss.some((u) => /\.woff2/i.test(u)));

  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      {
        url: "https://cdn.thebalvenie.com/cdn/shop/t/12/assets/theme.css",
        sourceUrl: OFFICIAL_PAGE
      },
      {
        url: "https://cdn.thebalvenie.com/products/bottle-a-caribbean.webp",
        sourceUrl: OFFICIAL_PAGE
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async (url) => {
      if (/\.css/i.test(url)) {
        return { width: null, height: null, mimeType: "text/css", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async () => ({
      correct_product: false,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    })
  });

  const diags = sanitizeJobDiagnostics(result.diagnostics).imageCandidates ?? [];
  assert.ok(
    !diags.some((d) => /\.css/i.test(d.urlPath || "") || /theme\.css/i.test(d.urlPath || "")),
    "stylesheet URL must not appear as an image candidate diagnostic"
  );
  assert.ok(diags.some((d) => /bottle-a/i.test(d.urlPath || "")));
});

test("12-14. threshold 75, score weights and source trust unchanged", () => {
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.equal(IMAGE_SCORE.officialSource, 40);
  assert.equal(IMAGE_SCORE.exactIdentityMatch, 30);
  assert.equal(IMAGE_SCORE.cleanProductPhoto, 20);
  assert.equal(IMAGE_SCORE.largeImage, 10);
  assert.equal(IMAGE_SCORE.unknownSource, -100);
});

test("15. Balvenie fixture: junk + decorative + four bottles; probe prefers official", async () => {
  const ordered = orderSeedsForProbe([
    { url: "https://junk.example/a.jpg", sourceUrl: null },
    { url: "https://cdn.thebalvenie.com/b.webp", sourceUrl: OFFICIAL_PAGE },
    { url: "https://junk.example/c.jpg", sourceUrl: null }
  ]);
  assert.equal(ordered[0].sourceUrl, OFFICIAL_PAGE);

  const bottles = [
    "https://cdn.thebalvenie.com/products/bottle-a-caribbean.webp",
    "https://cdn.thebalvenie.com/products/bottle-b-caribbean.webp",
    "https://cdn.thebalvenie.com/products/bottle-c-caribbean.webp",
    "https://cdn.thebalvenie.com/products/bottle-d-caribbean.webp"
  ];
  const decorative = [
    "https://cdn.thebalvenie.com/assets/grain-texture.jpg",
    "https://cdn.thebalvenie.com/assets/regulatory-banner.png"
  ];
  const junk = Array.from({ length: 10 }, (_, i) => ({
    url: `https://search.example/ad-${i}.jpg`,
    sourceUrl: null as string | null
  }));

  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      ...junk,
      {
        url: "https://cdn.thebalvenie.com/cdn/shop/t/12/assets/theme.css",
        sourceUrl: OFFICIAL_PAGE
      },
      ...decorative.map((url) => ({ url, sourceUrl: OFFICIAL_PAGE })),
      ...bottles.map((url) => ({ url, sourceUrl: OFFICIAL_PAGE }))
    ],
    searchWebHits: async () => [],
    probeImageMeta: async (url) => {
      if (/\.css/i.test(url)) {
        return { width: null, height: null, mimeType: "text/css", reachable: true };
      }
      if (/grain|banner|search\.example/i.test(url)) {
        return { width: 800, height: 800, mimeType: "image/jpeg", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/webp", reachable: true };
    },
    verifyImage: async ({ imageUrl }) => visionFor(imageUrl)
  });

  const working = result.diagnostics.imageCandidates ?? [];
  const verificationWorking = working.filter(isVerificationStage);
  assert.ok(verificationWorking.length >= Math.min(4, IMAGE_MAX_VISION_CHECKS));
  assert.ok(
    verificationWorking.every(
      (d) => d.vision?.ran && (d.vision.correctProduct != null || d.vision.error)
    )
  );
  assert.ok(
    verificationWorking.every((d) => d.accepted || (d.rejectionReasons?.length ?? 0) > 0)
  );

  const bounded = prioritizeImageCandidateDiagnostics(working, 12);
  assert.ok(bounded.slice(0, verificationWorking.length).every(isVerificationStage));
  assert.ok(!bounded.some((d) => /theme\.css/i.test(d.urlPath || "")));

  const verifyStage = result.diagnostics.stages?.find((s) => s.stage === "verify");
  assert.ok(verifyStage);
  const consistency = checkVerificationDiagnosticConsistency({
    verificationCountFromStages: verifyStage!.candidateCount ?? 0,
    diagnostics: working
  });
  assert.equal(consistency.ok, true);
});
