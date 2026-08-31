/**
 * Final-state metadata diagnostics + official-page <img> image fallback (Balvenie).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  classifyImageSource,
  executeImageEnrichment,
  extractOfficialPageImgCandidates,
  IMAGE_ACCEPTANCE_THRESHOLD,
  isLikelyPageDecoration
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
  metadataEnrichmentAvailability,
  metadataOutcomeFromState,
  parseMetadataJobResult,
  previewEnrichmentBackfill,
  runMetadataJob,
  unresolvedMetadataFields
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

function insertBalvenie() {
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, sub_category, abv, volume_ml, upc, image_url)
    VALUES (?, ?, '', '', 0, 750, ?, '')
  `).run("Balvenie 14 Yr Carribbean", "The Balvenie", UPC);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(Number(result.lastInsertRowid)) as Record<
    string,
    unknown
  >;
}

const OFFICIAL_PAGE_NO_META = `
<html><body>
  <img src="/assets/logo.svg" alt="The Balvenie logo" width="64" height="64"/>
  <img src="https://cdn.thebalvenie.com/icons/menu.png" alt="menu" width="32" height="32"/>
  <img src="https://cdn.thebalvenie.com/pixel.gif" width="1" height="1" alt=""/>
  <img
    src="https://cdn.thebalvenie.com/products/caribbean-cask-hero.jpg"
    alt="The Balvenie Caribbean Cask 14 Year Old bottle"
    width="900"
    height="1200"
  />
  <img src="https://cdn.thebalvenie.com/social/facebook.png" alt="facebook" width="40" height="40"/>
</body></html>
`;

test("1-6. metadata unresolved comes from final persisted state; Partial with only ttb_id", async () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC });
  const claimed = claimNextPendingJob()!;
  assert.equal(claimed.job_type, "metadata");

  const run = await runMetadataJob(claimed, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Caribbean Cask | The Balvenie",
        content: "Single Malt Scotch Whisky",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
      }
    ],
    fetchPageHtml: async () => `
      <html><head>
        <meta property="og:description" content="Scotch Whisky 43% ABV Speyside Scotland"/>
        <script type="application/ld+json">
          {"@type":"Product","name":"Caribbean Cask","alcoholByVolume":"43%","description":"Speyside Single Malt Scotch Whisky"}
        </script>
      </head></html>
    `,
    extractMetadata: async () => ({
      category: "Scotch Whisky",
      abv: 43,
      origin: "Speyside",
      proof: null,
      ttb_id: null
    })
  });
  assert.equal(run.skipped, false);
  markJobCompleted(claimed.id, run.resultPayload);

  const stored = parseMetadataJobResult(
    (db.prepare(`SELECT result_json FROM enrichment_jobs WHERE id=?`).get(claimed.id) as { result_json: string })
      .result_json
  );
  assert.ok(stored);
  assert.ok(stored!.updated.includes("abv"));
  assert.ok(stored!.updated.includes("proof"), "derived proof must count as updated");
  assert.ok(stored!.updated.includes("origin"));
  assert.ok(stored!.updated.includes("category"));
  assert.deepEqual(
    stored!.unresolved.filter((f) => stored!.updated.includes(f)),
    [],
    "updated field cannot remain unresolved"
  );
  assert.ok(stored!.unresolved.includes("ttb_id"));
  assert.ok(!stored!.unresolved.includes("abv"));
  assert.ok(!stored!.unresolved.includes("proof"));
  assert.ok(!stored!.unresolved.includes("category"));
  assert.ok(!stored!.unresolved.includes("origin"));
  assert.match(String(stored!.diagnostics?.summary ?? ""), /still missing ttb_id/i);
  assert.doesNotMatch(String(stored!.diagnostics?.summary ?? ""), /still missing abv/i);

  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
  assert.equal(Number(row.abv), 43);
  const candidate = candidateFromInventoryRow("spirits", row);
  assert.equal(candidate.abv.value, 43);
  assert.equal(candidate.proof.value, 86);
  assert.equal(candidate.origin.value, "Speyside");
  assert.equal(candidate.ttb_id.value, null);
  assert.deepEqual(unresolvedMetadataFields(candidate), ["ttb_id"]);

  const outcome = metadataOutcomeFromState({
    candidate,
    entityType: "spirits",
    entityId: id
  });
  assert.equal(outcome, "partial");

  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!;
  const metaJob = view.enrichment.jobs.find((j) => j.type === "metadata");
  assert.equal(metaJob?.statusLabel, "partial");
  assert.equal(
    metadataEnrichmentAvailability({ candidate, entityType: "spirits", entityId: id }),
    "partial"
  );

  previewEnrichmentBackfill();
  cleanup();
});

test("7-11. official page without OG/JSON-LD falls back to product <img>; logos/tiny rejected; CDN provenance", async () => {
  const scan = extractOfficialPageImgCandidates(
    OFFICIAL_PAGE_NO_META,
    "https://www.thebalvenie.com/en-us/range/caribbean-cask",
    { brand: "The Balvenie", name: "Balvenie 14 Yr Carribbean" }
  );
  assert.ok(scan.scanned >= 4);
  assert.ok(scan.prefiltered.some((c) => /caribbean-cask-hero/i.test(c.url)));
  assert.ok(scan.prefiltered.every((c) => !/logo|menu|facebook|pixel/i.test(c.url)));
  assert.ok(isLikelyPageDecoration({ url: "https://cdn.x/logo.svg", alt: "logo" }).reject);
  assert.ok(isLikelyPageDecoration({ url: "https://cdn.x/x.png", width: 1, height: 1 }).reject);

  const candidate = candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      category: null,
      abv: null,
      volume_ml: 750
    },
    "vault"
  );

  let visionCalls = 0;
  const result = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [],
    searchWebHits: async () => [
      {
        title: "Caribbean Cask",
        content: "Official",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
      }
    ],
    fetchPageHtml: async () => OFFICIAL_PAGE_NO_META,
    probeImageMeta: async (url) => ({
      width: /hero/i.test(url) ? 900 : 40,
      height: /hero/i.test(url) ? 1200 : 40,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async ({ imageUrl }) => {
      visionCalls += 1;
      const ok = /hero/i.test(imageUrl);
      return {
        correct_product: ok,
        bottle_prominent: ok,
        contains_people: false,
        meme_or_graphic: false,
        clean_product_photo: ok
      };
    }
  });

  assert.ok(result.diagnostics.stages.some((s) => s.stage === "official_page_img_scan"));
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "official_page_img_prefilter"));
  const hero = result.evaluated.find((c) => /caribbean-cask-hero/i.test(c.url));
  assert.ok(hero);
  assert.equal(hero!.sourceType, "official");
  assert.equal(hero!.sourceUrl, "https://www.thebalvenie.com/en-us/range/caribbean-cask");
  assert.ok(visionCalls >= 1, "vision verification still runs");
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);

  // Generic CDN host (no brand token) is not trusted alone — only via official page reference.
  assert.equal(
    classifyImageSource("https://img.brandassets.net/products/caribbean-cask-hero.jpg", {
      brand: "The Balvenie"
    }),
    "unknown"
  );
  assert.equal(
    classifyImageSource("https://img.brandassets.net/products/caribbean-cask-hero.jpg", {
      brand: "The Balvenie",
      pageUrl: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
    }),
    "official"
  );
});

test("12-16. retailer rejected; no suitable official image → No result; threshold unchanged", async () => {
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  const candidate = candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      volume_ml: 750
    },
    "vault"
  );

  const retail = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [
      {
        url: "https://www.totalwine.com/media/balvenie.jpg",
        sourceUrl: "https://www.totalwine.com/spirits/balvenie",
        width: 1000,
        height: 1400
      }
    ],
    searchWebHits: async () => [
      {
        title: "Buy",
        content: "Sale",
        url: "https://www.totalwine.com/spirits/balvenie"
      }
    ],
    fetchPageHtml: async () => "<html></html>",
    probeImageMeta: async () => ({
      width: 1000,
      height: 1400,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => {
      throw new Error("should not verify retailer");
    }
  });
  assert.ok(retail.evaluated.every((c) => c.rejected || c.sourceType === "unknown"));
  assert.equal(retail.selected, null);

  const emptyOfficial = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [],
    searchWebHits: async () => [
      {
        title: "Official",
        content: "Page",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
      }
    ],
    fetchPageHtml: async () => `
      <html><body>
        <img src="/logo.svg" alt="logo" width="40" height="40"/>
        <img src="/icon.png" alt="icon" width="24" height="24"/>
      </body></html>
    `,
    probeImageMeta: async () => ({
      width: 40,
      height: 40,
      mimeType: "image/png",
      reachable: true
    }),
    verifyImage: async () => ({
      correct_product: true,
      bottle_prominent: true,
      contains_people: false,
      meme_or_graphic: false,
      clean_product_photo: true
    })
  });
  assert.equal(emptyOfficial.selected, null);
  assert.ok(emptyOfficial.diagnostics.noResultReason);
});

test("17-18. patron EnrichmentPanel wiring and scan-session untouched by this polish", async () => {
  const fs = await import("node:fs/promises");
  const panel = await fs.readFile(new URL("../client/src/EnrichmentPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /diagnosticSummary|diagnostics/);
  const scan = await fs.readFile(new URL("./scan-session.ts", import.meta.url), "utf8");
  assert.match(scan, /scan-session|saveScanSession/);
  assert.doesNotMatch(panel, /enrichment\/health/);
});
