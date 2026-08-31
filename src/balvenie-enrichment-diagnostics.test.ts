/**
 * Enrichment diagnostics + Balvenie source-quality regression (fakes only).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { parseExtracted } from "./ingestion/enrichment/metadata-extract.js";
import {
  buildMetadataSearchQueries,
  classifySourceUrl,
  executeImageEnrichment,
  executeMetadataEnrichment,
  extractProductImageUrlsFromHtml,
  hostLooksLikeBrandDomain,
  planEnrichment,
  proofFromAbv
} from "./ingestion/enrichment/index.js";
import { WebSearchError } from "./ingestion/web-search.js";
import {
  buildBottleEnrichmentView,
  candidateFromInventoryRow,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  clearProductImagesForTests,
  dedupeMissingLabels,
  enqueueMetadataJob,
  markJobCompleted
} from "./ingestion/jobs/index.js";
import { candidateFromProduct } from "./ingestion/candidate/index.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");

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

function balvenieCandidate() {
  return candidateFromProduct(
    {
      upc: UPC,
      name: "Balvenie 14 Yr Carribbean",
      brand: "The Balvenie",
      product_type: "spirit",
      category: null,
      abv: null,
      proof: null,
      volume_ml: 750,
      origin: null,
      ttb_id: null
    },
    "vault"
  );
}

test("1. missing-field labels are deduplicated", () => {
  cleanup();
  const spirit = insertBalvenie();
  const view = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: Number(spirit.id)
  })!;
  const labels = view.enrichment.missing;
  assert.equal(labels.filter((l) => l === "Category").length, 1);
  assert.deepEqual(dedupeMissingLabels(["Category", "Category", "ABV"]), ["Category", "ABV"]);
  cleanup();
});

test("2-3. metadata query recorded and search result count recorded", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const queries = buildMetadataSearchQueries(candidate, ["category", "abv", "proof"]);
  assert.ok(queries.some((q) => /Balvenie/i.test(q) && /083664871681/.test(q)));
  assert.ok(!queries.some((q) => q.trim().toLowerCase() === "balvenie"));

  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "The Balvenie Caribbean Cask",
        content: "Scotch Whisky 43% ABV Scotland",
        url: "https://www.thebalvenie.com/en-us/caribbean-cask"
      }
    ],
    extractMetadata: async () => ({
      category: "Scotch Whisky",
      abv: 43,
      origin: "Scotland",
      proof: null,
      ttb_id: null
    })
  });

  const searchStage = result.diagnostics.stages.find((s) => s.stage === "search");
  assert.ok(searchStage?.query);
  assert.match(String(searchStage?.query), /Balvenie/);
  assert.equal(searchStage?.candidateCount, 1);
  assert.ok(result.updated.includes("category") || result.diagnostics.accepted?.includes("category"));
  assert.equal(result.candidate.abv.value, 43);
  assert.equal(result.candidate.proof.value, proofFromAbv(43));
  assert.equal(result.candidate.origin.value, "Scotland");
  assert.equal(result.candidate.product_type.value, "spirit");
});

test("4-6. official accepted; retailer and blog rejected", () => {
  assert.equal(
    classifySourceUrl("https://www.thebalvenie.com/products/caribbean-cask", {
      brand: "The Balvenie"
    }),
    "official"
  );
  assert.equal(
    classifySourceUrl("https://shop.thebalvenie.com/caribbean-cask", { brand: "The Balvenie" }),
    "official"
  );
  assert.ok(hostLooksLikeBrandDomain("shop.thebalvenie.com", "The Balvenie"));
  assert.equal(
    classifySourceUrl("https://www.totalwine.com/spirits/balvenie", { brand: "The Balvenie" }),
    "retailer"
  );
  assert.equal(
    classifySourceUrl("https://www.reddit.com/r/Scotch/comments/xyz", { brand: "The Balvenie" }),
    "ugc"
  );
  assert.equal(
    classifySourceUrl("https://www.ttb.gov/foia/cola", { brand: "The Balvenie" }),
    "regulatory"
  );
});

test("7. Scenario A: authoritative source extraction accepted", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Caribbean Cask 14",
        content: "Single malt Scotch Whisky, 43% ABV, distilled in Scotland.",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
      }
    ],
    extractMetadata: async () => ({
      category: "Scotch Whisky",
      abv: 43,
      origin: "Scotland",
      proof: null,
      ttb_id: null
    })
  });
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "source_selection" && s.acceptedCount === 1));
  assert.equal(result.candidate.category.value, "Scotch Whisky");
  assert.ok(!result.diagnostics.noResultReason);
  assert.ok(result.updated.length > 0);
});

test("8. Scenario B: retailer/blog only → no_authoritative_sources", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Buy Balvenie",
        content: "Scotch on sale",
        url: "https://www.totalwine.com/spirits/scotch/balvenie"
      },
      {
        title: "Review",
        content: "I love this whisky",
        url: "https://www.reddit.com/r/Scotch/comments/abc"
      }
    ],
    extractMetadata: async () => {
      throw new Error("extractor should not run");
    }
  });
  assert.equal(result.diagnostics.noResultReason, "no_authoritative_sources");
  assert.equal(result.updated.length, 0);
  assert.equal(result.candidate.category.value, null);
});

test("9. Scenario C: extractor null → extractor_returned_null", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Official",
        content: "Product page",
        url: "https://www.thebalvenie.com/en-us/caribbean-cask"
      }
    ],
    extractMetadata: async () => ({
      category: null,
      abv: null,
      proof: null,
      origin: null,
      ttb_id: null
    })
  });
  assert.equal(result.diagnostics.noResultReason, "extractor_returned_null");
});

test("10. invalid extracted numeric produces validation rejection", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Official",
        content: "ABV listed as 0",
        url: "https://www.thebalvenie.com/x"
      }
    ],
    extractMetadata: async () => ({ abv: 0, category: "Food", proof: null })
  });
  assert.ok(
    result.diagnostics.rejectReasons?.some(
      (r) => r.reason === "invalid_numeric" || r.reason === "classification_not_canonical"
    )
  );
});

test("11. Scenario D: SearXNG unavailable is retryable error not ordinary no-result", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => {
      throw new WebSearchError("timeout", "SearXNG timeout: aborted");
    },
    extractMetadata: async () => ({})
  });
  assert.ok(result.errors.length > 0);
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "search" && s.status === "error"));
  assert.equal(result.diagnostics.noResultReason, "provider_error");
  assert.notEqual(result.diagnostics.noResultReason, "no_search_results");
});

test("12. Ollama/extractor provider failure becomes error", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "Official",
        content: "notes",
        url: "https://www.thebalvenie.com/x"
      }
    ],
    extractMetadata: async () => {
      throw new Error("Ollama returned 503");
    }
  });
  assert.ok(result.errors.length > 0);
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "extract" && s.status === "error"));
});

test("13. successful zero search results = no_search_results", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [],
    extractMetadata: async () => ({})
  });
  assert.equal(result.diagnostics.noResultReason, "no_search_results");
});

test("14-16. image rejection / verification / score diagnostics", async () => {
  const candidate = balvenieCandidate();
  const rejected = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [
      {
        url: "https://cdn.totalwine.com/balvenie.jpg",
        sourceUrl: "https://www.totalwine.com/spirits/balvenie",
        width: 1200,
        height: 1600
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
      isProductBottle: true,
      matchesIdentity: true,
      containsPeople: false,
      isMemeOrGraphic: false,
      confidence: 0.9
    })
  });
  assert.ok(
    rejected.diagnostics.stages.some((s) => s.stage === "hard_filter" || s.stage === "candidates")
  );
  assert.ok(rejected.evaluated.some((e) => e.rejected));

  const verifiedReject = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [
      {
        url: "https://www.thebalvenie.com/images/bottle.jpg",
        sourceUrl: "https://www.thebalvenie.com/caribbean-cask",
        width: 1200,
        height: 1600
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
      isProductBottle: false,
      matchesIdentity: false,
      containsPeople: true,
      isMemeOrGraphic: false,
      confidence: 0.2
    })
  });
  assert.equal(verifiedReject.selected, null);
  assert.ok(
    verifiedReject.diagnostics.noResultReason === "verification_rejected"
      || verifiedReject.diagnostics.noResultReason === "all_image_candidates_rejected"
      || verifiedReject.diagnostics.noResultReason === "score_below_threshold"
  );

  const scoreReject = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [
      {
        url: "https://www.thebalvenie.com/images/bottle2.jpg",
        sourceUrl: "https://www.thebalvenie.com/caribbean-cask",
        width: 1200,
        height: 1600
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
      isProductBottle: true,
      matchesIdentity: true,
      containsPeople: false,
      isMemeOrGraphic: false,
      confidence: 0.4
    })
  });
  assert.equal(scoreReject.selected, null);
  assert.ok(scoreReject.diagnostics.stages.some((s) => s.stage === "verify"));
});

test("17-19. diagnostics keeper-only; patrons do not see them; no secrets", async () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  markJobCompleted(enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job.id, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"],
    diagnostics: {
      jobType: "metadata",
      noResultReason: "no_authoritative_sources",
      summary: "No authoritative source produced usable metadata",
      stages: [
        {
          stage: "search",
          status: "ok",
          query: "The Balvenie Balvenie 14 Yr Carribbean 083664871681",
          provider: "searxng",
          candidateCount: 4
        }
      ],
      requested: ["category", "abv"]
    }
  });

  const guest = await app.inject({
    method: "GET",
    url: `/api/inventory/spirits/${id}/enrichment`
  });
  assert.equal(guest.statusCode, 200);
  const guestBody = guest.json() as {
    enrichment: { jobs: Array<{ diagnostics?: unknown; diagnosticSummary?: unknown }> };
  };
  const guestMeta = guestBody.enrichment.jobs.find((j) => j.type === "metadata" || true);
  // Without admin token, diagnostics must be absent.
  for (const job of guestBody.enrichment.jobs) {
    assert.equal(job.diagnostics, undefined);
    assert.equal(job.diagnosticSummary, undefined);
  }

  const token = createTestAdminToken();
  const admin = await app.inject({
    method: "GET",
    url: `/api/inventory/spirits/${id}/enrichment`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(admin.statusCode, 200);
  const adminBody = admin.json() as {
    enrichment: {
      jobs: Array<{
        type: string;
        diagnostics?: { stages?: Array<{ query?: string }>; summary?: string | null };
        diagnosticSummary?: string | null;
      }>;
    };
  };
  const meta = adminBody.enrichment.jobs.find((j) => j.type === "metadata");
  assert.ok(meta?.diagnostics || meta?.diagnosticSummary);
  const blob = JSON.stringify(meta);
  assert.ok(!/api[_-]?key|password|pin|Bearer /i.test(blob));
  assert.ok(!/You extract factual/i.test(blob));
  cleanup();
});

test("parseExtracted accepts numeric strings and Scotch Whisky / Scotland", () => {
  const parsed = parseExtracted(
    JSON.stringify({
      category: "Scotch Whisky",
      abv: "43%",
      origin: "Scotland",
      proof: null
    }),
    ["category", "abv", "origin", "proof"]
  );
  assert.equal(parsed.category, "Scotch Whisky");
  assert.equal(parsed.abv, 43);
  assert.equal(parsed.origin, "Scotland");
  assert.equal(parsed.proof, null);

  const fromNumber = parseExtracted(JSON.stringify({ abv: 43 }), ["abv"]);
  assert.equal(fromNumber.abv, 43);
});

test("og:image extraction from authoritative HTML", () => {
  const html = `
    <html><head>
      <meta property="og:image" content="/images/hero-bottle.jpg" />
      <script type="application/ld+json">
        {"@type":"Product","name":"Caribbean Cask","image":"https://cdn.thebalvenie.com/bottle.png"}
      </script>
    </head></html>
  `;
  const urls = extractProductImageUrlsFromHtml(html, "https://www.thebalvenie.com/caribbean-cask");
  assert.ok(urls.some((u) => /hero-bottle/.test(u)));
  assert.ok(urls.some((u) => /cdn\.thebalvenie\.com\/bottle\.png/.test(u)));
});

test("20. existing metadata outcome semantics remain correct", () => {
  cleanup();
  const spirit = insertBalvenie();
  const id = Number(spirit.id);
  markJobCompleted(enqueueMetadataJob({ entityType: "spirits", entityId: id, upc: UPC }).job.id, {
    requested: ["category"],
    updated: [],
    unresolved: ["category"]
  });
  const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id })!;
  assert.equal(view.enrichment.jobs.find((j) => j.type === "metadata")?.statusLabel, "no_result");
  cleanup();
});
