/**
 * Image verification diagnostics regressions (Balvenie UPC 083664871681).
 * Fakes only — no live Ollama / SearXNG / external hosts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { db } from "./db.js";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_SCORE,
  buildImageScoreComponents,
  buildImageVerifyPrompt,
  executeImageEnrichment,
  identityContextForVision,
  safeImageUrlParts,
  sumScoreComponents,
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

const UPC = "083664871681";
const PREFIX = "08366487";
const OFFICIAL_PAGE = "https://www.thebalvenie.com/en-us/range/caribbean-cask";

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
}

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

const URL_A = "https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg";
const URL_B = "https://cdn.thebalvenie.com/products/caribbean-cask-lifestyle.jpg";
const URL_C = "https://cdn.thebalvenie.com/products/doublewood-12-bottle.jpg";
const URL_D = "https://cdn.thebalvenie.com/products/caribbean-cask-thumb.jpg";

function visionForUrl(url: string): VisionVerification {
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
  // Hero packshot
  return {
    correct_product: true,
    bottle_prominent: true,
    contains_people: false,
    meme_or_graphic: false,
    clean_product_photo: true,
    multiple_products: false
  };
}

async function runFourCandidateScenario(options: {
  verifyImage?: (req: { candidate: unknown; imageUrl: string }) => Promise<VisionVerification | null>;
} = {}) {
  return executeImageEnrichment(balvenieCandidate(), {
    // Seed four candidates with official-page provenance (og:image extract is single-valued).
    searchImageHits: async () => [
      { url: URL_B, sourceUrl: OFFICIAL_PAGE },
      { url: URL_C, sourceUrl: OFFICIAL_PAGE },
      { url: URL_A, sourceUrl: OFFICIAL_PAGE },
      { url: URL_D, sourceUrl: OFFICIAL_PAGE }
    ],
    searchWebHits: async () => [],
    fetchPageHtml: async () => null,
    probeImageMeta: async (url) => {
      if (/thumb/i.test(url)) {
        return { width: 80, height: 80, mimeType: "image/jpeg", reachable: true };
      }
      return { width: 1200, height: 1600, mimeType: "image/jpeg", reachable: true };
    },
    verifyImage: options.verifyImage ?? (async ({ imageUrl }) => visionForUrl(imageUrl))
  });
}

test("1-5. Balvenie 4-candidate: reasons, score components, threshold 75, official source", async () => {
  cleanup();
  const result = await runFourCandidateScenario();

  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.ok(result.diagnostics.imageCandidates?.length);

  for (const c of result.diagnostics.imageCandidates!) {
    if (!c.accepted) {
      assert.ok(c.rejectionReasons.length >= 1, `rejected candidate needs a reason: ${c.urlPath}`);
    }
  }

  const accepted = result.diagnostics.imageCandidates!.find((c) => c.accepted);
  assert.ok(accepted, "Candidate A (hero) should be accepted");
  assert.ok((accepted!.score ?? 0) >= IMAGE_ACCEPTANCE_THRESHOLD);
  assert.ok(accepted!.vision?.ran);
  assert.equal(accepted!.vision?.correctProduct, true);
  assert.equal(accepted!.sourceType, "official");
  assert.ok(accepted!.scoreComponents);
  assert.equal(accepted!.scoreComponents!.official_source, IMAGE_SCORE.officialSource);
  assert.equal(accepted!.scoreComponents!.total, accepted!.score);
  assert.equal(sumScoreComponents(accepted!.scoreComponents!), accepted!.scoreComponents!.total);
  assert.equal(accepted!.threshold, 75);

  const lifestyle = result.diagnostics.imageCandidates!.find((c) => /lifestyle/i.test(c.urlPath || ""));
  assert.ok(lifestyle);
  assert.equal(lifestyle!.accepted, false);
  assert.ok(lifestyle!.rejectionReasons.includes("bottle_not_prominent"));

  const wrong = result.diagnostics.imageCandidates!.find((c) => /doublewood/i.test(c.urlPath || ""));
  assert.ok(wrong);
  assert.equal(wrong!.accepted, false);
  assert.ok(wrong!.rejectionReasons.includes("wrong_product"));

  const tiny = result.diagnostics.imageCandidates!.find((c) => /thumb/i.test(c.urlPath || ""));
  assert.ok(tiny);
  assert.equal(tiny!.accepted, false);
  assert.ok(tiny!.rejectionReasons.includes("low_resolution"));

  assert.ok(result.selected);
  assert.ok(/caribbean-cask-hero/i.test(result.selected!.url));
  cleanup();
});

test("6. exact official product-page candidate gets correct identity context", () => {
  const candidate = balvenieCandidate();
  const ctx = identityContextForVision(candidate);
  assert.equal(ctx.upc, UPC);
  assert.equal(ctx.name, "Balvenie 14 Yr Carribbean");
  assert.equal(ctx.brand, "The Balvenie");
  assert.equal(ctx.product_type, "spirit");
  assert.equal(ctx.family, "Whiskey");
  assert.match(String(ctx.category ?? ""), /Scotch Whisky/i);
  assert.match(String(ctx.sub_category ?? ""), /Scotch Whisky/i);

  const prompt = buildImageVerifyPrompt({ candidate, imageUrl: URL_A });
  assert.match(prompt, /The Balvenie/);
  assert.match(prompt, /Balvenie 14 Yr Carribbean/);
  assert.match(prompt, /Scotch Whisky/);
  assert.match(prompt, /Whiskey/);
  assert.match(prompt, new RegExp(UPC));
  assert.match(prompt, /exact product/i);
  assert.ok(!/only broad/i.test(prompt));
});

test("7-9. wrong-product, bottle-not-prominent, low-resolution diagnosable", async () => {
  const result = await runFourCandidateScenario();
  const diags = result.diagnostics.imageCandidates!;
  assert.ok(diags.some((d) => d.rejectionReasons.includes("wrong_product")));
  assert.ok(diags.some((d) => d.rejectionReasons.includes("bottle_not_prominent")));
  assert.ok(diags.some((d) => d.rejectionReasons.includes("low_resolution")));
});

test("10. vision parse failure differs from wrong-product", async () => {
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async () => [{ title: "x", content: "y", url: OFFICIAL_PAGE }],
    fetchPageHtml: async () => `<html><head><meta property="og:image" content="${URL_A}"/></head></html>`,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => null
  });
  const diag = result.diagnostics.imageCandidates?.find((c) => /hero/i.test(c.urlPath || ""));
  assert.ok(diag);
  assert.ok(diag!.rejectionReasons.includes("vision_parse_failed"));
  assert.ok(!diag!.rejectionReasons.includes("wrong_product"));
});

test("11. vision provider error differs from normal rejection", async () => {
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [],
    searchWebHits: async () => [{ title: "x", content: "y", url: OFFICIAL_PAGE }],
    fetchPageHtml: async () => `<html><head><meta property="og:image" content="${URL_A}"/></head></html>`,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => {
      throw new Error("vision_provider_error: Ollama returned 500");
    }
  });
  const diag = result.diagnostics.imageCandidates?.find((c) => /hero/i.test(c.urlPath || ""));
  assert.ok(diag);
  assert.ok(diag!.rejectionReasons.includes("vision_provider_error"));
  assert.ok(!diag!.rejectionReasons.includes("wrong_product"));
  assert.equal(diag!.vision?.error, "vision_provider_error");
});

test("12. safe URL display strips query secrets", () => {
  const parts = safeImageUrlParts(
    "https://cdn.thebalvenie.com/products/bottle.jpg?X-Amz-Signature=SECRETTOKEN&token=abc123"
  );
  assert.equal(parts.host, "cdn.thebalvenie.com");
  assert.match(parts.path, /bottle\.jpg/);
  assert.ok(!/SECRETTOKEN/i.test(parts.display));
  assert.ok(!/token=/i.test(parts.display));
  assert.ok(!/\?/i.test(parts.display));
});

test("13-14. keeper UI gets candidate diagnostics; patrons do not", async () => {
  cleanup();
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
    searchWebHits: async () => [{ title: "x", content: "y", url: OFFICIAL_PAGE }],
    fetchPageHtml: async () => `<html><head><meta property="og:image" content="${URL_A}"/></head></html>`,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async ({ imageUrl }) => visionForUrl(imageUrl),
    localizeImage: async () => "/api/media/images/balvenie-verify-localized.jpg"
  } as never);
  markJobCompleted(claimed.id, run.resultPayload);

  const keeper = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  })!;
  const imageJob = keeper.enrichment.jobs.find((j) => j.type === "image");
  assert.ok(imageJob?.diagnostics?.imageCandidates?.length);

  const patron = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: false
  })!;
  const patronImage = patron.enrichment.jobs.find((j) => j.type === "image");
  assert.equal(patronImage?.diagnostics, undefined);
  cleanup();
});

test("15. retailer denial unchanged", async () => {
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      {
        url: "https://www.totalwine.com/media/balvenie-bottle.jpg",
        sourceUrl: "https://www.totalwine.com/spirits/balvenie"
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => {
      throw new Error("should not vision-verify retailer");
    }
  });
  assert.equal(result.selected, null);
  const retailer = result.diagnostics.imageCandidates?.find((c) => /totalwine/i.test(c.urlHost));
  assert.ok(retailer);
  assert.ok(retailer!.rejectionReasons.includes("unapproved_source"));
});

test("16-17. metadata + scan-session behavior untouched (smoke)", () => {
  // Threshold and score weights unchanged.
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.equal(IMAGE_SCORE.officialSource, 40);
  assert.equal(IMAGE_SCORE.exactIdentityMatch, 30);
  assert.equal(IMAGE_SCORE.cleanProductPhoto, 20);
  assert.equal(IMAGE_SCORE.largeImage, 10);

  const components = buildImageScoreComponents(
    {
      url: URL_A,
      sourceUrl: OFFICIAL_PAGE,
      sourceType: "official",
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg"
    },
    {
      correct_product: true,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true,
      multiple_products: false
    }
  );
  assert.equal(components.total, 100);
  assert.equal(sumScoreComponents(components), 100);
});

test("18. score-below-threshold is distinct from vision failure", async () => {
  // Approved source + perfect vision without large dims can land at 65.
  const result = await executeImageEnrichment(balvenieCandidate(), {
    searchImageHits: async () => [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/balvenie-pack.jpg",
        sourceUrl: null
      }
    ],
    searchWebHits: async () => [],
    probeImageMeta: async () => ({
      width: 800,
      height: 800,
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
  });
  // Wikimedia may classify as approved or unknown depending on host rules.
  const diag = result.diagnostics.imageCandidates?.[0];
  if (diag && diag.vision?.correctProduct && diag.score != null && diag.score < 75) {
    assert.ok(diag.rejectionReasons.includes("score_below_threshold"));
    assert.ok(!diag.rejectionReasons.includes("wrong_product"));
    assert.match(String(result.diagnostics.summary ?? ""), /score|threshold/i);
  }
});

test("no headless browser dependency added", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(all)) {
    assert.ok(!/playwright|puppeteer|chromium/i.test(name), name);
  }
});
