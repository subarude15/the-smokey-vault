/**
 * Progressive search + official-domain discovery regression (Balvenie UPC 083664871681).
 * Fakes only — no live SearXNG / Ollama / internet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateFromProduct } from "./ingestion/candidate/index.js";
import {
  buildImageQueryTiers,
  buildMetadataQueryTiers,
  buildMetadataSearchQueries,
  classifyImageSource,
  classifySourceUrl,
  classifySourceUrlWithDiscovery,
  discoverOfficialDomains,
  executeImageEnrichment,
  executeMetadataEnrichment,
  extractSearchTokens,
  extractStructuredProductFacts,
  IMAGE_ACCEPTANCE_THRESHOLD,
  planEnrichment,
  proofFromAbv,
  queryQuotesEntireName,
  searchAliasesForToken
} from "./ingestion/enrichment/index.js";
import { WebSearchError } from "./ingestion/web-search.js";

const UPC = "083664871681";

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

const OFFICIAL_HTML = `
<html><head>
<meta property="og:image" content="https://cdn.thebalvenie.com/products/caribbean-cask.jpg"/>
<meta property="og:description" content="Single Malt Scotch Whisky, 43% ABV, Speyside Scotland"/>
<script type="application/ld+json">
{"@type":"Product","name":"Caribbean Cask 14 Year Old","description":"Scotch Whisky 43% ABV from Scotland","alcoholByVolume":"43%","image":"https://cdn.thebalvenie.com/products/caribbean-cask-jsonld.jpg"}
</script>
</head><body>The Balvenie Caribbean Cask</body></html>
`;

test("1-2. zero-result strict query falls through; earlier success stops ladder", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const seen: string[] = [];
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async (query) => {
      seen.push(query);
      // Restrictive / UPC-only style → empty; relaxed Caribbean → official.
      if (/083664871681/.test(query) && !/Caribbean|Year|ABV|COLA/i.test(query)) {
        return [];
      }
      if (/Caribbean/i.test(query) || /14 Year/i.test(query)) {
        return [
          {
            title: "Caribbean Cask 14 Year Old | The Balvenie",
            content: "Single Malt Scotch Whisky 43% ABV Scotland",
            url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
          }
        ];
      }
      return [];
    },
    fetchPageHtml: async () => OFFICIAL_HTML,
    extractMetadata: async ({ webSnippets }) => {
      assert.match(webSnippets, /43/);
      return {
        category: "Scotch Whisky",
        abv: 43,
        origin: "Scotland",
        proof: null,
        ttb_id: null
      };
    }
  });

  assert.ok(seen.length >= 2, "must try more than the first empty tier");
  assert.ok(
    result.diagnostics.stages.some((s) => s.stage === "query_ladder_stop" && /enough_evidence|ladder/.test(String(s.reason)))
  );
  // After authoritative hit, should not exhaust every remaining tier.
  assert.ok(seen.length < 6, "bounded early stop");
  assert.equal(result.candidate.abv.value, 43);
  assert.equal(result.candidate.proof.value, proofFromAbv(43));
  assert.equal(result.candidate.category.value, "Scotch Whisky");
});

test("3-5. queries avoid full-name quotes, allow independent UPC, drop package noise", () => {
  const candidate = balvenieCandidate();
  const tiers = buildMetadataQueryTiers(
    {
      brand: "The Balvenie",
      name: "Balvenie 14 Yr Carribbean 750 ml",
      upc: UPC,
      product_type: "spirit",
      volume_ml: 750
    },
    ["category", "abv"]
  );
  const queries = tiers.map((t) => t.query);
  assert.ok(queries.every((q) => !queryQuotesEntireName(q, "Balvenie 14 Yr Carribbean 750 ml")));
  assert.ok(queries.every((q) => !q.includes('"Balvenie 14 Yr Carribbean')));
  assert.ok(queries.some((q) => q.startsWith(UPC) || q.includes(` ${UPC}`) || new RegExp(`^${UPC}\\b`).test(q) || q.includes(UPC)));
  assert.ok(queries.some((q) => /083664871681/.test(q) && !/14 Year|Caribbean/i.test(q)), "UPC tier independent of exact name");
  assert.ok(queries.every((q) => !/\b750\b/.test(q) && !/\bml\b/i.test(q)));
  assert.ok(queries.every((q) => !/\bspirit\b/i.test(q)));
  assert.equal(buildMetadataSearchQueries(candidate, ["abv"]).length > 0, true);
});

test("6-8. Yr/Whisky aliases are retrieval-only and do not mutate canonical name", async () => {
  assert.deepEqual(searchAliasesForToken("Yr").map((t) => t.toLowerCase()).sort(), ["year", "yr"].sort());
  assert.ok(searchAliasesForToken("whisky").some((t) => /whiskey/i.test(t)));
  assert.ok(searchAliasesForToken("Carribbean").some((t) => /caribbean/i.test(t)));

  const tokens = extractSearchTokens({
    brand: "The Balvenie",
    name: "Balvenie 14 Yr Carribbean",
    upc: UPC,
    product_type: "spirit",
    volume_ml: 750
  });
  assert.ok(tokens.productTokens.some((t) => /Year/i.test(t)));
  assert.ok(tokens.productTokens.some((t) => /Caribbean/i.test(t)));

  const candidate = balvenieCandidate();
  const beforeName = candidate.name.value;
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [
      {
        title: "The Balvenie",
        content: "Scotch Whisky 43% ABV",
        url: "https://www.thebalvenie.com/caribbean-cask"
      }
    ],
    fetchPageHtml: async () => null,
    extractMetadata: async () => ({
      category: "Scotch Whisky",
      abv: 43,
      origin: "Scotland",
      proof: null,
      ttb_id: null
    })
  });
  assert.equal(result.candidate.name.value, beforeName);
  assert.match(String(result.candidate.name.value), /Carribbean/);
  assert.ok(!/Caribbean/.test(String(result.candidate.name.value)));
});

test("9-12. official domain discovery; subdomain ok; retailer/blog rejected", () => {
  const discovery = discoverOfficialDomains(
    [
      {
        title: "Caribbean Cask | The Balvenie",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask",
        content: "Official product page"
      },
      {
        title: "Buy Balvenie",
        url: "https://www.totalwine.com/spirits/balvenie",
        content: "Sale"
      }
    ],
    { brand: "The Balvenie" }
  );
  assert.ok(discovery.domains.includes("thebalvenie.com"));

  assert.equal(
    classifySourceUrlWithDiscovery("https://shop.thebalvenie.com/caribbean-cask", {
      brand: "The Balvenie",
      discoveredOfficialDomains: ["thebalvenie.com"]
    }),
    "official"
  );
  assert.equal(
    classifySourceUrl("https://www.totalwine.com/spirits/balvenie", { brand: "The Balvenie" }),
    "retailer"
  );
  assert.equal(
    classifySourceUrlWithDiscovery("https://www.totalwine.com/spirits/balvenie", {
      brand: "The Balvenie",
      discoveredOfficialDomains: ["thebalvenie.com"]
    }),
    "retailer"
  );
  assert.equal(
    classifySourceUrl("https://www.reddit.com/r/Scotch/comments/x", { brand: "The Balvenie" }),
    "ugc"
  );
  assert.equal(
    classifyImageSource("https://www.totalwine.com/images/balvenie.jpg", {
      brand: "The Balvenie",
      pageUrl: "https://www.totalwine.com/spirits/balvenie"
    }),
    "unknown"
  );
});

test("13. official page structured metadata provides factual extraction text", () => {
  const facts = extractStructuredProductFacts(
    OFFICIAL_HTML,
    "https://www.thebalvenie.com/en-us/range/caribbean-cask"
  );
  assert.equal(facts.abv, 43);
  assert.ok(facts.usedJsonLd);
  assert.ok(facts.usedOpenGraph);
  assert.match(facts.textSnippet, /Scotch|43/i);
  assert.ok(facts.imageUrls.some((u) => /caribbean-cask/.test(u)));
});

test("14-16. official og:image and JSON-LD enter image pipeline; thresholds unchanged; retailers rejected", async () => {
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  const candidate = balvenieCandidate();
  let fetchedOfficial = false;
  const result = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [
      {
        url: "https://www.totalwine.com/media/balvenie.jpg",
        sourceUrl: "https://www.totalwine.com/spirits/balvenie",
        width: 900,
        height: 1200
      }
    ],
    searchWebHits: async (query) => {
      if (/official|Balvenie|Caribbean|14/i.test(query)) {
        return [
          {
            title: "Caribbean Cask | The Balvenie",
            content: "Official range page",
            url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
          }
        ];
      }
      return [];
    },
    fetchPageHtml: async (url) => {
      if (/thebalvenie\.com/i.test(url)) {
        fetchedOfficial = true;
        return OFFICIAL_HTML;
      }
      return null;
    },
    probeImageMeta: async (url) => ({
      width: 1000,
      height: 1400,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async ({ imageUrl }) => ({
      isCorrectProduct: /cdn\.thebalvenie\.com/i.test(imageUrl),
      isCleanBottleShot: /cdn\.thebalvenie\.com/i.test(imageUrl),
      confidence: /cdn\.thebalvenie\.com/i.test(imageUrl) ? 90 : 10,
      reasons: []
    })
  });

  assert.equal(fetchedOfficial, true);
  assert.ok(
    result.diagnostics.stages.some(
      (s) => s.stage === "official_domain_discovered" && /thebalvenie\.com/.test(String(s.reason))
    )
  );
  assert.ok(
    result.evaluated.some((c) => /cdn\.thebalvenie\.com/i.test(c.url) && c.sourceType === "official")
  );
  assert.ok(
    result.evaluated.some(
      (c) => /totalwine/i.test(c.url) && (c.rejected || c.sourceType === "unknown")
    )
  );
  // Threshold not lowered — acceptance still requires score >= 75 after vision.
  if (result.selected) {
    assert.ok(result.selected.score >= IMAGE_ACCEPTANCE_THRESHOLD);
  }
});

test("17. query-tier diagnostics are stored", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => [],
    extractMetadata: async () => ({})
  });
  assert.ok(result.diagnostics.stages.some((s) => /^query_tier_/.test(s.stage)));
  assert.equal(result.diagnostics.noResultReason, "no_search_results");
});

test("18. SearXNG failure semantics remain provider_error", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async () => {
      throw new WebSearchError("unreachable", "SearXNG unreachable: fetch failed");
    },
    extractMetadata: async () => ({})
  });
  assert.equal(result.diagnostics.noResultReason, "provider_error");
  assert.ok(result.errors.length > 0);
});

test("19. image progressive tiers avoid stuffing exact stored name + spirit + upc always", () => {
  const tiers = buildImageQueryTiers({
    brand: "The Balvenie",
    name: "Balvenie 14 Yr Carribbean",
    upc: UPC,
    product_type: "spirit",
    volume_ml: 750
  });
  assert.ok(tiers.length >= 2);
  assert.ok(tiers.some((t) => /Caribbean|Year/i.test(t.query)));
  assert.ok(tiers.every((t) => !queryQuotesEntireName(t.query, "Balvenie 14 Yr Carribbean")));
});

test("20. Balvenie end-to-end: empty first query → official facts + image meta; name unchanged", async () => {
  const candidate = balvenieCandidate();
  const plan = planEnrichment(candidate);
  const storedName = candidate.name.value;

  const meta = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "none", upc: UPC }),
    searchWebHits: async (query) => {
      if (/Caribbean|Year|ABV|COLA|official/i.test(query) && !/^083664871681 Balvenie$/i.test(query.trim())) {
        return [
          {
            title: "The Balvenie Caribbean Cask",
            content: "Product overview",
            url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
          }
        ];
      }
      return [];
    },
    fetchPageHtml: async () => OFFICIAL_HTML,
    extractMetadata: async ({ webSnippets }) => {
      assert.match(webSnippets, /43%|ABV: 43/i);
      return {
        category: "Scotch Whisky",
        abv: 43,
        origin: "Scotland",
        proof: null,
        ttb_id: null
      };
    }
  });

  assert.equal(meta.candidate.name.value, storedName);
  assert.equal(meta.candidate.category.value, "Scotch Whisky");
  assert.equal(meta.candidate.abv.value, 43);
  assert.equal(meta.candidate.proof.value, proofFromAbv(43));
  assert.ok(meta.diagnostics.stages.some((s) => s.stage === "official_domain_discovered"));
  assert.ok(meta.diagnostics.stages.some((s) => s.stage === "source_fetch" && s.status === "ok"));

  const images = await executeImageEnrichment(candidate, {
    searchImageHits: async () => [],
    searchWebHits: async () => [
      {
        title: "Caribbean Cask",
        content: "Official",
        url: "https://www.thebalvenie.com/en-us/range/caribbean-cask"
      }
    ],
    fetchPageHtml: async () => OFFICIAL_HTML,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => ({
      isCorrectProduct: true,
      isCleanBottleShot: true,
      confidence: 92,
      reasons: ["clean bottle"]
    })
  });

  assert.ok(images.evaluated.some((c) => /cdn\.thebalvenie\.com/i.test(c.url)));
  assert.ok(
    images.diagnostics.stages.some(
      (s) => s.stage === "official_image_meta" || s.reason === "official_image_metadata_found"
        || s.stage === "official_page_outcome"
    )
  );
});
