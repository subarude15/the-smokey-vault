/**
 * Progressive image discovery: FWGS → official → generic SearXNG last.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { field } from "../candidate/index.js";
import type { BottleCandidate } from "../candidate/types.js";
import { executeImageEnrichment } from "./execute-images.js";
import { isNonImageAssetUrl } from "./image-candidate-diagnostics.js";
import { classifyImageSource } from "./image-sources.js";
import { hardRejectCandidate } from "./image-score.js";
import { IMAGE_ACCEPTANCE_THRESHOLD } from "./image-thresholds.js";

const CAPTAIN_PLCB = "000004766";
const CAPTAIN_FWGS =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475";
const CAPTAIN_FWGS_1200 =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=1200&width=1200";

const GILBEYS_PLCB = "000005295";
const GILBEYS_FWGS =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000005295_F1.jpg&height=475&width=475";
const GILBEYS_FWGS_1200 =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000005295_F1.jpg&height=1200&width=1200";

const OFFICIAL_PAGE = "https://www.gilbeys.com/products/london-dry-gin";
const OFFICIAL_IMAGE = "https://cdn.gilbeys.com/products/london-dry-gin.jpg";
const CRAFT_OFFICIAL_IMAGE = "https://cdn.craftco.com/products/craft-beer-can.jpg";
const LICENSED_FALLBACK = "https://upload.wikimedia.org/wikipedia/commons/a/a1/gin-bottle.jpg";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

const cleanVision = {
  correct_product: true,
  bottle_prominent: true,
  contains_people: false,
  meme_or_graphic: false,
  clean_product_photo: true,
  multiple_products: false
};

const wrongVision = {
  correct_product: false,
  bottle_prominent: true,
  contains_people: false,
  meme_or_graphic: false,
  clean_product_photo: true,
  multiple_products: false
};

function plcbCandidate(options: {
  plcb: string;
  upc: string;
  name: string;
  brand: string;
  category?: string;
}): BottleCandidate {
  const proof = field(80, "plcb_spirits");
  proof.sourceItemId = options.plcb;
  return {
    primarySource: "plcb_spirits",
    upc: field(options.upc, "plcb_spirits"),
    name: field(options.name, "plcb_spirits"),
    brand: field(options.brand, "plcb_spirits"),
    product_type: field("", "unknown"),
    category: field(options.category ?? "Gin", "plcb_spirits"),
    abv: field(40, "plcb_spirits"),
    proof,
    volume_ml: field(750, "plcb_spirits"),
    origin: field("United Kingdom", "plcb_spirits"),
    ttb_id: field("", "unknown")
  };
}

function captainCandidate(): BottleCandidate {
  return plcbCandidate({
    plcb: CAPTAIN_PLCB,
    upc: "087000201156",
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    category: "Rum"
  });
}

function gilbeysCandidate(): BottleCandidate {
  return plcbCandidate({
    plcb: GILBEYS_PLCB,
    upc: "080686122128",
    name: "Gilbey's London Dry Gin",
    brand: "Gilbey's",
    category: "Gin"
  });
}

function noPlcbCandidate(): BottleCandidate {
  return {
    primarySource: "upc_lookup",
    upc: field("012345678901", "upc_lookup"),
    name: field("Some Craft Beer", "upc_lookup"),
    brand: field("Craft Co", "upc_lookup"),
    product_type: field("beer", "upc_lookup"),
    category: field("Beer", "upc_lookup"),
    abv: field(5, "upc_lookup"),
    proof: field(null, "unknown"),
    volume_ml: field(355, "upc_lookup"),
    origin: field("United States", "upc_lookup"),
    ttb_id: field("", "unknown")
  };
}

function countGenericSearchStages(stages: Array<{ stage: string }>): number {
  return stages.filter((s) => s.stage === "generic_image_search" || /^query_tier_/.test(s.stage)).length;
}

test("placeholder prefilter rejects default.jpg / placeholder paths", () => {
  assert.equal(
    isNonImageAssetUrl("https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg"),
    true
  );
  assert.equal(
    isNonImageAssetUrl("https://cdn.example.com/assets/placeholder.png"),
    true
  );
  assert.equal(
    isNonImageAssetUrl("https://cdn.example.com/media/no-image.jpg"),
    true
  );
  assert.equal(
    isNonImageAssetUrl("https://cdn.example.com/media/missing-image.png"),
    true
  );
  assert.equal(
    isNonImageAssetUrl("https://cdn.example.com/img/spacer.gif"),
    true
  );
});

test("placeholder prefilter is conservative — .edu product photos are not blocked by TLD", () => {
  assert.equal(
    isNonImageAssetUrl("https://example.edu/products/gilbeys-bottle.jpg"),
    false
  );
  assert.equal(
    isNonImageAssetUrl("https://museum.edu/collection/spirits/london-dry-gin.webp"),
    false
  );
});

test("retailer remains unapproved after progressive refactor", () => {
  const source = classifyImageSource("https://www.totalwine.com/media/sys_master/twmmedia/gin.jpg", {
    brand: "Gilbey's",
    pageUrl: "https://www.totalwine.com/spirits/gilbeys"
  });
  assert.equal(source, "unknown");
  assert.equal(
    hardRejectCandidate({
      url: "https://www.totalwine.com/media/sys_master/twmmedia/gin.jpg",
      sourceUrl: "https://www.totalwine.com/spirits/gilbeys",
      sourceType: source,
      width: 1400,
      height: 1400,
      mimeType: "image/jpeg"
    }).reason,
    "unapproved_source"
  );
});

test("1. VALID FWGS ACCEPTED — generic SearXNG image search call count = 0", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(png, { status: 200, headers: { "Content-Type": "image/png" } })) as typeof fetch;

  let imageSearchCalls = 0;
  try {
    const result = await executeImageEnrichment(captainCandidate(), {
      searchImageHits: async () => {
        imageSearchCalls += 1;
        return [{ url: "https://thumbs.dreamstime.com/junk.jpg" }];
      },
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async () => ({
        matched: true,
        plcbItem: CAPTAIN_PLCB,
        imageUrls: [CAPTAIN_FWGS],
        primaryImageUrl: CAPTAIN_FWGS,
        extractionSource: "embedded_json"
      }),
      verifyImage: async () => cleanVision
    });

    assert.equal(imageSearchCalls, 0);
    assert.ok(result.selected?.url.includes("000004766_F1.jpg"));
    assert.ok((result.selected?.score ?? 0) >= IMAGE_ACCEPTANCE_THRESHOLD);
    assert.ok(result.diagnostics.stages.some((s) => s.stage === "strong_source_selected"));
    assert.ok(
      result.diagnostics.stages.some(
        (s) => s.stage === "generic_image_search_skipped" && s.reason === "generic_search_not_needed"
      )
    );
    assert.equal(countGenericSearchStages(result.diagnostics.stages), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("2. FWGS REJECTED → FALLBACK — generic search eventually runs", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("gilbeys.com") || url.includes("finewineandgoodspirits")) {
      return new Response(png, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  let imageSearchCalls = 0;
  try {
    const result = await executeImageEnrichment(gilbeysCandidate(), {
      searchImageHits: async () => {
        imageSearchCalls += 1;
        return [{ url: OFFICIAL_IMAGE, sourceUrl: OFFICIAL_PAGE }];
      },
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async () => ({
        matched: true,
        plcbItem: GILBEYS_PLCB,
        imageUrls: [GILBEYS_FWGS],
        primaryImageUrl: GILBEYS_FWGS,
        extractionSource: "embedded_json"
      }),
      verifyImage: async ({ imageUrl }) => {
        if (imageUrl.includes("000005295")) return wrongVision;
        return cleanVision;
      }
    });

    assert.ok(imageSearchCalls >= 1, "generic image search should run after FWGS rejection");
    assert.ok(result.diagnostics.stages.some((s) => s.stage === "generic_image_search"));
    assert.ok(
      result.diagnostics.stages.some(
        (s) => s.stage === "generic_image_search" && s.reason === "fallback_fwgs_rejected"
      )
    );
    assert.equal(result.selected?.url, OFFICIAL_IMAGE);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3. FWGS NO RESULT → FALLBACK proceeds", async () => {
  let imageSearchCalls = 0;
  const result = await executeImageEnrichment(gilbeysCandidate(), {
    searchImageHits: async () => {
      imageSearchCalls += 1;
      return [];
    },
    searchWebHits: async () => [],
    fetchPageHtml: async () => null,
    extractFwgsPlcbImages: async () => ({
      matched: true,
      plcbItem: GILBEYS_PLCB,
      imageUrls: [],
      primaryImageUrl: null,
      extractionSource: "embedded_json"
    }),
    verifyImage: async () => cleanVision
  });

  assert.ok(imageSearchCalls >= 1);
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "fwgs_figranium_images" && s.status === "no_result"));
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "generic_image_search"));
  assert.equal(result.selected, null);
});

test("4. OFFICIAL IMAGE ACCEPTED — generic image SERP call count = 0", async () => {
  let imageSearchCalls = 0;
  // PLCB present but Figranium not configured / not injected → no FWGS stage.
  const result = await executeImageEnrichment(gilbeysCandidate(), {
    searchImageHits: async () => {
      imageSearchCalls += 1;
      return [{ url: "https://thumbs.dreamstime.com/should-not-run.jpg" }];
    },
    searchWebHits: async () => [
      {
        title: "London Dry Gin | Gilbey's Official",
        content: "Official product page for Gilbey's London Dry Gin",
        url: OFFICIAL_PAGE
      }
    ],
    fetchPageHtml: async (url) => {
      if (url === OFFICIAL_PAGE) {
        return `<html><head>
          <meta property="og:image" content="${OFFICIAL_IMAGE}" />
          <meta property="og:type" content="product" />
        </head><body></body></html>`;
      }
      return null;
    },
    probeImageMeta: async () => ({
      width: 1400,
      height: 1600,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => cleanVision
  });

  assert.equal(imageSearchCalls, 0);
  assert.equal(result.selected?.url, OFFICIAL_IMAGE);
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "official_image_selected"));
  assert.ok(
    result.diagnostics.stages.some(
      (s) => s.stage === "generic_image_search_skipped" && s.reason === "generic_search_not_needed"
    )
  );
});

test("5. NO TRUSTED STRUCTURED SOURCE — generic image search still runs", async () => {
  let imageSearchCalls = 0;
  const result = await executeImageEnrichment(noPlcbCandidate(), {
    searchImageHits: async () => {
      imageSearchCalls += 1;
      return [{ url: CRAFT_OFFICIAL_IMAGE, sourceUrl: "https://www.craftco.com/products/craft-beer" }];
    },
    searchWebHits: async () => [],
    fetchPageHtml: async () => null,
    probeImageMeta: async () => ({
      width: 1200,
      height: 1400,
      mimeType: "image/jpeg",
      reachable: true
    }),
    verifyImage: async () => cleanVision
  });

  assert.ok(imageSearchCalls >= 1);
  assert.ok(result.diagnostics.stages.some((s) => s.stage === "generic_image_search"));
  assert.equal(result.selected?.url, CRAFT_OFFICIAL_IMAGE);
});

test("6. TRANSIENT FWGS ERROR — does not silently fall back to generic image search", async () => {
  let imageSearchCalls = 0;
  const result = await executeImageEnrichment(captainCandidate(), {
    searchImageHits: async () => {
      imageSearchCalls += 1;
      return [{ url: LICENSED_FALLBACK }];
    },
    searchWebHits: async () => [],
    fetchPageHtml: async () => null,
    extractFwgsPlcbImages: async () => {
      throw new Error("Figranium temporary 503 timeout");
    },
    verifyImage: async () => cleanVision
  });

  assert.equal(imageSearchCalls, 0);
  assert.equal(result.selected, null);
  assert.equal(result.diagnostics.noResultReason, "provider_error");
  assert.ok(result.errors.some((e) => /503|timeout|Figranium/i.test(e)));
  assert.ok(
    result.diagnostics.stages.some(
      (s) =>
        s.stage === "generic_image_search_skipped"
        && s.reason === "fwgs_provider_error_no_generic_fallback"
    )
  );
});

test("7. PLACEHOLDER PREFILTER — artic.edu default.jpg never probed/visioned", async () => {
  let probeCalls = 0;
  let visionCalls = 0;
  const result = await executeImageEnrichment(noPlcbCandidate(), {
    searchImageHits: async () => [
      {
        url: "https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg",
        sourceUrl: null
      },
      {
        url: CRAFT_OFFICIAL_IMAGE,
        sourceUrl: "https://www.craftco.com/products/craft-beer"
      }
    ],
    searchWebHits: async () => [],
    fetchPageHtml: async () => null,
    probeImageMeta: async (url) => {
      probeCalls += 1;
      assert.ok(!/default\.jpg/i.test(url), "placeholder must not be probed");
      return { width: 1200, height: 1400, mimeType: "image/jpeg", reachable: true };
    },
    verifyImage: async ({ imageUrl }) => {
      visionCalls += 1;
      assert.ok(!/default\.jpg/i.test(imageUrl), "placeholder must not reach vision");
      return cleanVision;
    }
  });

  assert.ok(probeCalls >= 1);
  assert.ok(visionCalls >= 1);
  assert.equal(result.selected?.url, CRAFT_OFFICIAL_IMAGE);
  assert.ok(
    !(result.diagnostics.imageCandidates ?? []).some((d) => /default\.jpg/i.test(d.urlPath || ""))
  );
});

test("10. CAPTAIN MORGAN REGRESSION — validated FWGS accepted, generic never invoked", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("finewineandgoodspirits.com")) {
      return new Response("akamai deny", { status: 403 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  let imageSearchCalls = 0;
  try {
    const result = await executeImageEnrichment(captainCandidate(), {
      searchImageHits: async () => {
        imageSearchCalls += 1;
        return [
          { url: "https://thumbs.dreamstime.com/captain.jpg" },
          { url: "https://www.totalwine.com/media/captain.jpg" },
          { url: "https://www.artic.edu/iiif/2/x/full/843,/0/default.jpg" }
        ];
      },
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async () => ({
        matched: true,
        plcbItem: CAPTAIN_PLCB,
        imageUrls: [CAPTAIN_FWGS],
        primaryImageUrl: CAPTAIN_FWGS,
        extractionSource: "embedded_json"
      }),
      fetchFwgsImageViaFigranium: async (imageUrl) => ({
        ok: true,
        image: {
          plcbItem: CAPTAIN_PLCB,
          sourceUrl: imageUrl,
          contentType: "image/png",
          bytes: png,
          width: 1200,
          height: 1200
        }
      }),
      verifyImage: async () => cleanVision
    });

    assert.equal(imageSearchCalls, 0);
    assert.equal(result.selected?.url, CAPTAIN_FWGS_1200);
    assert.equal(result.selected?.identityMatched, true);
    assert.ok((result.selected?.score ?? 0) >= IMAGE_ACCEPTANCE_THRESHOLD);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("11. GILBEYS REGRESSION — FWGS success never reaches Dreamstime/random SERP/artic.edu", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(png, { status: 200, headers: { "Content-Type": "image/png" } })) as typeof fetch;

  let imageSearchCalls = 0;
  let probedJunk = false;
  try {
    const result = await executeImageEnrichment(gilbeysCandidate(), {
      searchImageHits: async () => {
        imageSearchCalls += 1;
        return [
          { url: "https://thumbs.dreamstime.com/gilbeys.jpg" },
          { url: "https://www.blueoceanmy.com/gin.jpg" },
          { url: "https://www.totalwine.com/media/gilbeys.jpg" },
          { url: "https://www.artic.edu/iiif/2/x/full/843,/0/default.jpg" }
        ];
      },
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async () => ({
        matched: true,
        plcbItem: GILBEYS_PLCB,
        imageUrls: [GILBEYS_FWGS],
        primaryImageUrl: GILBEYS_FWGS,
        extractionSource: "embedded_json"
      }),
      probeImageMeta: async (url) => {
        if (/dreamstime|blueocean|totalwine|artic\.edu/i.test(url)) probedJunk = true;
        return {
          width: 1200,
          height: 1200,
          mimeType: "image/png",
          reachable: true,
          probeDetails: ["direct_probe_ok"],
          resolvedUrl: url.includes("475") ? GILBEYS_FWGS_1200 : url
        };
      },
      verifyImage: async () => cleanVision
    });

    assert.equal(imageSearchCalls, 0);
    assert.equal(probedJunk, false);
    assert.ok(result.selected?.url.includes("000005295_F1.jpg"));
    assert.ok(
      !(result.evaluated ?? []).some((c) =>
        /dreamstime|blueocean|totalwine|artic\.edu/i.test(c.url)
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
