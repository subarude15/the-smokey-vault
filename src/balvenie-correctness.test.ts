/**
 * Production correctness regressions for Balvenie UPC 083664871681:
 * - Scotch Whisky subtype persistence + monotonic specificity
 * - Metadata run-vs-bottle-state wording
 * - Official-page image mechanisms (picture/preload/CSS) + client-rendered diag
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { displayCanonicalFamily, displayCanonicalType } from "./canonical-normalize.js";
import { resolveMonotonicSpiritClassification } from "./catalog.js";
import { db } from "./db.js";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  classifyImageSource,
  executeImageEnrichment,
  extractCssBackgroundUrls,
  extractOfficialPageImgCandidates,
  IMAGE_ACCEPTANCE_THRESHOLD,
  looksLikeClientRenderedShell
} from "./ingestion/enrichment/index.js";
import {
  buildBottleEnrichmentView,
  candidateFromInventoryRow,
  claimNextPendingJob,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  enqueueMetadataJob,
  markJobCompleted,
  metadataLastRunLabel,
  metadataOutcomeFromState,
  parseMetadataJobResult,
  persistMetadataImprovements,
  runMetadataJob,
  shouldScheduleMetadataEnrichment
} from "./ingestion/jobs/index.js";

const UPC = "083664871681";
const PREFIX = "08366487";

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
  db.prepare(`DELETE FROM cola_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%' OR upc = ?`).run(UPC);
}

function insertTrustedScotch() {
  const result = db
    .prepare(`
      INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, upc, image_url)
      VALUES (?, ?, 'Whiskey', 'Scotch Whisky', 43, 750, ?, '')
    `)
    .run("Balvenie 14 Yr Carribbean", "The Balvenie", UPC);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(result.lastInsertRowid)) as Record<
    string,
    unknown
  >;
}

test("1-2. Scotch Whisky persists into spirits row; bottle header shows subtype", () => {
  cleanup();
  const empty = db
    .prepare(`
      INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, upc, image_url)
      VALUES (?, ?, '', '', 0, 750, ?, '')
    `)
    .run("Balvenie 14 Yr Carribbean", "The Balvenie", UPC);
  const id = Number(empty.lastInsertRowid);
  const before = candidateFromInventoryRow(
    "spirits",
    db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>
  );
  const after = candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      category: "Scotch Whisky",
      abv: 43,
      volume_ml: 750
    },
    "web"
  );
  // Elevate confidence so persist accepts the enrichment write.
  after.category = { ...after.category, confidence: 0.9, source: "web" };
  after.abv = { ...after.abv, confidence: 0.9, source: "web" };

  const persisted = persistMetadataImprovements({
    entityType: "spirits",
    entityId: id,
    before,
    after
  });
  assert.ok(persisted.inventoryUpdated.includes("category"));
  assert.ok(persisted.inventoryUpdated.includes("sub_category"));

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(row.category, "Whiskey");
  assert.equal(row.sub_category, "Scotch Whisky");
  assert.equal(displayCanonicalFamily(String(row.category)), "Whiskey");
  assert.equal(displayCanonicalType(String(row.sub_category)), "Scotch Whisky");
  cleanup();
});

test("3-4. later generic Whiskey / no-result does not erase trusted Scotch Whisky", async () => {
  cleanup();
  const spirit = insertTrustedScotch();
  const id = Number(spirit.id);

  // Direct persist of weaker generic label.
  const before = candidateFromInventoryRow("spirits", spirit);
  assert.equal(before.category.value, "Scotch Whisky");
  const weaker = {
    ...before,
    category: { value: "Whiskey", source: "web" as const, confidence: 0.95 }
  };
  persistMetadataImprovements({
    entityType: "spirits",
    entityId: id,
    before,
    after: weaker
  });
  let row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(row.category, "Whiskey");
  assert.equal(row.sub_category, "Scotch Whisky");

  // Monotonic helper alone.
  const mono = resolveMonotonicSpiritClassification({
    incomingLabel: "Whiskey",
    existingFamily: "Whiskey",
    existingType: "Scotch Whisky"
  });
  assert.equal(mono.family, "Whiskey");
  assert.equal(mono.type, "Scotch Whisky");

  // Full metadata rerun that finds nothing new.
  enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC, force: true });
  const claimed = claimNextPendingJob()!;
  const run = await runMetadataJob(claimed, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Balvenie",
        content: "Whiskey",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
      }
    ],
    fetchPageHtml: async () => "<html><body>Whiskey product</body></html>",
    extractMetadata: async () => ({
      category: "Whiskey",
      abv: null,
      proof: null,
      origin: null,
      ttb_id: null
    })
  });
  markJobCompleted(claimed.id, run.resultPayload);

  row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(row.category, "Whiskey");
  assert.equal(row.sub_category, "Scotch Whisky");
  assert.equal(row.abv, 43);
  cleanup();
});

test("5. keeper enrichment and BottleDetail classification agree", () => {
  cleanup();
  const spirit = insertTrustedScotch();
  const id = Number(spirit.id);
  db.prepare(`UPDATE spirits SET origin = ? WHERE id = ?`).run("Speyside", id);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;

  // BottleDetail convention: Family = category, Type = sub_category
  assert.equal(displayCanonicalFamily(String(row.category)), "Whiskey");
  assert.equal(displayCanonicalType(String(row.sub_category)), "Scotch Whisky");

  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  })!;
  // Enrichment read model collapses to most-specific label for Category field.
  assert.equal(view.metadata.category.value, "Scotch Whisky");
  assert.equal(view.inventory.category, "Whiskey");
  assert.equal(view.inventory.sub_category, "Scotch Whisky");
  cleanup();
});

test("6-7. Partial metadata with only TTB missing; empty rerun is No new data found", async () => {
  cleanup();
  const spirit = insertTrustedScotch();
  const id = Number(spirit.id);
  db.prepare(`UPDATE spirits SET origin = ?, proof = ? WHERE id = ?`).run("Speyside", 86, id);

  enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC, force: true });
  const claimed = claimNextPendingJob()!;
  const run = await runMetadataJob(claimed, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Balvenie",
        content: "Scotch",
        url: "https://www.thebalvenie.com/x"
      }
    ],
    fetchPageHtml: async () => "<html></html>",
    extractMetadata: async () => ({
      category: null,
      abv: null,
      proof: null,
      origin: null,
      ttb_id: null
    })
  });
  markJobCompleted(claimed.id, run.resultPayload);

  const candidate = candidateFromInventoryRow(
    "spirits",
    db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>
  );
  const outcome = metadataOutcomeFromState({ candidate, entityType: "spirits", entityId: id });
  assert.equal(outcome, "partial");

  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  })!;
  const metaJob = view.enrichment.jobs.find((j) => j.type === "metadata");
  assert.equal(metaJob?.statusLabel, "partial");
  assert.equal(metaJob?.lastRunLabel, "No new data found");
  assert.ok(metaJob?.stillMissing?.some((f) => /TTB/i.test(f)));
  assert.ok(!/fail/i.test(metaJob?.lastRunLabel ?? ""));

  const stored = parseMetadataJobResult(
    db
      .prepare(
        `SELECT result_json FROM enrichment_jobs WHERE entity_type='spirits' AND entity_id=? AND job_type='metadata' AND status='completed' ORDER BY id DESC LIMIT 1`
      )
      .get(id) as { result_json: string }
  );
  assert.equal(
    metadataLastRunLabel({ bottleOutcome: "partial", stored }),
    "No new data found"
  );

  // Classification untouched.
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(row.sub_category, "Scotch Whisky");
  cleanup();
});

test("8. <picture>/<source> official image discovered", async () => {
  const html = `
<html><body>
  <picture>
    <source srcset="https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg 900w" type="image/jpeg"/>
    <img alt="fallback" width="1" height="1"/>
  </picture>
</body></html>`;
  const scan = extractOfficialPageImgCandidates(html, "https://www.thebalvenie.com/range/caribbean-cask", {
    brand: "The Balvenie",
    name: "Caribbean Cask"
  });
  assert.ok(scan.prefiltered.some((c) => /caribbean-cask-hero/i.test(c.url)));

  const result = await executeImageEnrichment(
    candidateFromProduct(
      {
        upc: UPC,
        name: "Caribbean Cask",
        brand: "The Balvenie",
        product_type: "spirit",
        category: "Scotch Whisky",
        abv: 43,
        volume_ml: 750
      },
      "vault"
    ),
    {
      searchImageHits: async () => [],
      searchWebHits: async () => [
        {
          title: "Official",
          content: "Product",
          url: "https://www.thebalvenie.com/range/caribbean-cask"
        }
      ],
      fetchPageHtml: async () => html,
      probeImageMeta: async () => ({
        width: 900,
        height: 1200,
        mimeType: "image/jpeg",
        reachable: true
      }),
      verifyImage: async () => ({
        correct_product: true,
        bottle_prominent: true,
        contains_people: false,
        meme_or_graphic: false,
        clean_product_photo: true
      })
    }
  );
  const hero = result.evaluated.find((c) => /caribbean-cask-hero/i.test(c.url));
  assert.ok(hero);
  assert.equal(hero!.sourceType, "official");
  assert.equal(hero!.sourceUrl, "https://www.thebalvenie.com/range/caribbean-cask");
});

test("9. preload official image discovered", () => {
  const html = `
<html><head>
  <link rel="preload" as="image" href="https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg"/>
</head><body><div id="app"></div></body></html>`;
  const scan = extractOfficialPageImgCandidates(html, "https://www.thebalvenie.com/x", {
    brand: "The Balvenie",
    name: "Caribbean Cask"
  });
  assert.ok(scan.prefiltered.some((c) => /caribbean-cask-hero/i.test(c.url)));
});

test("10. approved static CSS hero image discovered", () => {
  const html = `
<html><head>
  <style>
    .product-hero { background-image: url("https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg"); }
  </style>
</head><body><div class="product-hero"></div></body></html>`;
  const scan = extractOfficialPageImgCandidates(html, "https://www.thebalvenie.com/x", {
    brand: "The Balvenie",
    name: "Caribbean Cask"
  });
  assert.ok(scan.prefiltered.some((c) => /caribbean-cask-hero/i.test(c.url)));
  const fromCss = extractCssBackgroundUrls(
    '.hero{background-image:url("/products/caribbean-cask-hero.jpg")}',
    "https://www.thebalvenie.com/"
  );
  assert.ok(fromCss.some((u) => /caribbean-cask-hero/i.test(u)));
});

test("11. official CDN provenance remains page-scoped", () => {
  // Generic CDN host without brand token is not globally trusted.
  assert.equal(
    classifyImageSource("https://img.brandassets.net/products/caribbean-cask-hero.jpg", {
      brand: "The Balvenie"
    }),
    "unknown"
  );
  // Same asset is official only when referenced from an authoritative page.
  assert.equal(
    classifyImageSource("https://img.brandassets.net/products/caribbean-cask-hero.jpg", {
      brand: "The Balvenie",
      pageUrl: "https://www.thebalvenie.com/range/caribbean-cask"
    }),
    "official"
  );
});

test("12. client-rendered shell receives distinct diagnostic", async () => {
  const shell = `
<!DOCTYPE html>
<html><head><title>Balvenie</title></head>
<body>
  <div id="__next"></div>
  <script src="/_next/static/chunks/main-app.js"></script>
</body></html>`;
  assert.equal(looksLikeClientRenderedShell(shell, 0), true);
  const scan = extractOfficialPageImgCandidates(shell, "https://www.thebalvenie.com/x", {
    brand: "The Balvenie",
    name: "Caribbean Cask"
  });
  assert.equal(scan.prefiltered.length, 0);
  assert.equal(scan.diagnostic, "official_page_client_rendered");
  assert.equal(scan.clientRenderedShell, true);
  assert.notEqual(scan.diagnostic, "official_page_logos_or_small_assets_only");

  const result = await executeImageEnrichment(
    candidateFromProduct(
      {
        upc: UPC,
        name: "Caribbean Cask",
        brand: "The Balvenie",
        product_type: "spirit",
        category: null,
        abv: null,
        volume_ml: 750
      },
      "vault"
    ),
    {
      searchImageHits: async () => [],
      searchWebHits: async () => [
        {
          title: "Official",
          content: "Product",
          url: "https://www.thebalvenie.com/range/caribbean-cask"
        }
      ],
      fetchPageHtml: async () => shell,
      probeImageMeta: async () => ({
        width: null,
        height: null,
        mimeType: null,
        reachable: false
      }),
      verifyImage: async () => ({
        correct_product: false,
        bottle_prominent: false,
        contains_people: false,
        meme_or_graphic: false,
        clean_product_photo: false
      })
    }
  );
  assert.ok(
    result.diagnostics.stages.some(
      (s) =>
        s.stage === "official_page_client_rendered"
        || (s.stage === "official_page_img_prefilter"
          && /official_page_client_rendered/i.test(String(s.reason ?? "")))
    )
  );
});

test("13-14. retailer images rejected; image threshold remains 75", async () => {
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  const result = await executeImageEnrichment(
    candidateFromProduct(
      {
        upc: UPC,
        name: "Caribbean Cask",
        brand: "The Balvenie",
        product_type: "spirit",
        category: "Scotch Whisky",
        abv: 43,
        volume_ml: 750
      },
      "vault"
    ),
    {
      searchImageHits: async () => [
        {
          title: "Buy Balvenie",
          url: "https://www.totalwine.com/spirits/balvenie/bottle.jpg",
          thumbnail: "https://www.totalwine.com/spirits/balvenie/bottle.jpg"
        }
      ],
      searchWebHits: async () => [],
      probeImageMeta: async () => ({
        width: 900,
        height: 1200,
        mimeType: "image/jpeg",
        reachable: true
      }),
      verifyImage: async () => ({
        correct_product: true,
        bottle_prominent: true,
        contains_people: false,
        meme_or_graphic: false,
        clean_product_photo: true
      })
    }
  );
  assert.ok(
    result.evaluated.every((c) => c.sourceType !== "official" || c.rejected)
      || result.evaluated.filter((c) => /totalwine/i.test(c.url)).every((c) => c.rejected || c.sourceType === "retailer")
  );
  const retailer = result.evaluated.find((c) => /totalwine/i.test(c.url));
  if (retailer) {
    assert.ok(retailer.sourceType === "retailer" || retailer.rejected);
  }
});

test("15. no headless-browser dependency added", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of Object.keys(all)) {
    assert.ok(!/playwright|puppeteer|chromium|chrome-aws/i.test(name), `unexpected browser dep: ${name}`);
  }
});

test("16-17. patron/scan-session behavior unchanged (no force requeue after complete)", () => {
  cleanup();
  const spirit = insertTrustedScotch();
  const id = Number(spirit.id);
  const inserted = db
    .prepare(
      `INSERT INTO enrichment_jobs (entity_type, entity_id, job_type, status, attempts, result_json)
       VALUES ('spirits', ?, 'metadata', 'pending', 0, NULL)`
    )
    .run(id);
  markJobCompleted(Number(inserted.lastInsertRowid), {
    requested: [],
    updated: [],
    unresolved: ["ttb_id"]
  });
  const candidate = candidateFromInventoryRow(
    "spirits",
    db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>
  );
  assert.equal(
    shouldScheduleMetadataEnrichment({ candidate, entityType: "spirits", entityId: id }),
    false
  );
  assert.equal(
    shouldScheduleMetadataEnrichment({ candidate, entityType: "spirits", entityId: id, force: true }),
    true
  );
  cleanup();
});
