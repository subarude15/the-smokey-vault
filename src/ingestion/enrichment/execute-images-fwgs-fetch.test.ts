/**
 * FWGS Figranium image-fetch fallback + PLCB identity scoring wiring.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { field } from "../candidate/index.js";
import type { BottleCandidate } from "../candidate/types.js";
import {
  executeImageEnrichment,
  probeImageMetaWithFwgsFallback
} from "./execute-images.js";
import {
  deriveFwgsImageRenditionUrl,
  validateFwgsImageUrl,
  type FwgsImageFetchOutcome
} from "../../fwgs-figranium.js";
import {
  evaluateCandidate,
  scoreImageCandidateBase,
  type ImageCandidate
} from "./image-score.js";
import {
  IMAGE_ACCEPTANCE_THRESHOLD,
  IMAGE_MIN_HEIGHT,
  IMAGE_MIN_WIDTH,
  IMAGE_SCORE,
  IMAGE_VISION_CANDIDATE_FLOOR
} from "./image-thresholds.js";

const PLCB = "000004766";
const FWGS_F1 = "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475";
const FWGS_F1_1200 = "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=1200&width=1200";
const FWGS_WRONG = "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000008865_F1.jpg&height=475&width=475";
const OTHER_HOST = "https://cdn.example.com/captain.png";
const APPROVED_HOST = "https://www.totalwine.com/media/sys_master/twmmedia/captain.jpg";

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

function figraniumOk(
  png: Buffer,
  width = 1200,
  height = 1200,
  sourceUrl = FWGS_F1_1200
): FwgsImageFetchOutcome {
  return {
    ok: true,
    image: {
      plcbItem: PLCB,
      sourceUrl,
      contentType: "image/png",
      bytes: png,
      width,
      height
    }
  };
}

function captainCandidate(): BottleCandidate {
  const proof = field(70, "plcb_spirits");
  proof.sourceItemId = PLCB;
  return {
    primarySource: "plcb_spirits",
    upc: field("087000201156", "plcb_spirits"),
    name: field("Captain Morgan Original Spiced Rum", "plcb_spirits"),
    brand: field("Captain Morgan", "plcb_spirits"),
    product_type: field("", "unknown"),
    category: field("Rum", "plcb_spirits"),
    abv: field(35, "plcb_spirits"),
    proof,
    volume_ml: field(1750, "plcb_spirits"),
    origin: field("United States", "plcb_spirits"),
    ttb_id: field("", "unknown")
  };
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

test("deriveFwgsImageRenditionUrl changes only height/width", () => {
  const derived = deriveFwgsImageRenditionUrl(FWGS_F1, PLCB, {
    width: 1200,
    height: 1200
  });
  assert.equal(derived, FWGS_F1_1200);
  assert.equal(validateFwgsImageUrl(derived!, PLCB), true);
  assert.ok(derived!.includes("source=/file/v1/products/000004766_F1.jpg"));
  assert.ok(!derived!.includes("%2F"));
});

test("reachable FWGS image prefers higher-res rendition without Figranium", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  let figraniumCalls = 0;
  const probedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    probedUrls.push(String(input));
    return new Response(png, {
      status: 200,
      headers: { "Content-Type": "image/png" }
    });
  }) as typeof fetch;
  try {
    const ok = await probeImageMetaWithFwgsFallback(FWGS_F1, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async () => {
        figraniumCalls += 1;
        return { ok: false, reason: "figranium_error" };
      }
    });
    assert.equal(ok.reachable, true);
    assert.equal(figraniumCalls, 0);
    assert.equal(ok.resolvedUrl, FWGS_F1_1200);
    assert.equal(ok.width, 1200);
    assert.equal(ok.height, 1200);
    assert.ok(ok.probeDetails?.includes("direct_probe_ok"));
    assert.ok(ok.probeDetails?.includes("fwgs_higher_res_rendition_attempted"));
    assert.ok(ok.probeDetails?.includes("fwgs_higher_res_rendition_preferred"));
    assert.ok(probedUrls.includes(FWGS_F1_1200));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct FWGS fetch failure invokes Figranium fallback on higher-res rendition", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403 })) as typeof fetch;
  let fetchCalls = 0;
  const png = makePng(1200, 1200);
  try {
    const meta = await probeImageMetaWithFwgsFallback(FWGS_F1, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async (imageUrl, plcbItem) => {
        fetchCalls += 1;
        assert.equal(imageUrl, FWGS_F1_1200);
        assert.equal(plcbItem, PLCB);
        return figraniumOk(png, 1200, 1200, imageUrl);
      }
    });
    assert.equal(fetchCalls, 1);
    assert.equal(meta.reachable, true);
    assert.equal(meta.resolvedUrl, FWGS_F1_1200);
    assert.ok(meta.probeDetails?.includes("direct_probe_http_rejected"));
    assert.ok(meta.probeDetails?.includes("figranium_fetch_fallback_attempted"));
    assert.ok(meta.probeDetails?.includes("figranium_fetch_fallback_ok"));
    assert.ok(meta.probeDetails?.includes("fwgs_higher_res_rendition_preferred"));
    assert.ok(meta.imageBase64);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("wrong host never invokes Figranium image fetch fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403 })) as typeof fetch;
  let fetchCalls = 0;
  try {
    const meta = await probeImageMetaWithFwgsFallback(OTHER_HOST, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async () => {
        fetchCalls += 1;
        return { ok: false, reason: "figranium_error" };
      }
    });
    assert.equal(meta.reachable, false);
    assert.equal(fetchCalls, 0);
    assert.ok(!meta.probeDetails?.includes("figranium_fetch_fallback_attempted"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mismatched PLCB image URL never invokes Figranium fetch fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403 })) as typeof fetch;
  let fetchCalls = 0;
  try {
    const meta = await probeImageMetaWithFwgsFallback(FWGS_WRONG, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async () => {
        fetchCalls += 1;
        return { ok: false, reason: "figranium_error" };
      }
    });
    assert.equal(meta.reachable, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generic non-FWGS candidate cannot use browser fetch fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403 })) as typeof fetch;
  let fetchCalls = 0;
  try {
    const meta = await probeImageMetaWithFwgsFallback(APPROVED_HOST, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async () => {
        fetchCalls += 1;
        return { ok: false, reason: "figranium_error" };
      }
    });
    assert.equal(meta.reachable, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validated FWGS PLCB image receives exactIdentityMatch and clears vision floor", () => {
  const candidate: ImageCandidate = {
    url: FWGS_F1_1200,
    sourceUrl: `https://www.finewineandgoodspirits.com/product/${PLCB}`,
    sourceType: "approved",
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg",
    identityMatched: true
  };
  const base = scoreImageCandidateBase(candidate);
  assert.equal(
    base,
    IMAGE_SCORE.approvedSource + IMAGE_SCORE.exactIdentityMatch + IMAGE_SCORE.largeImage
  );
  assert.ok(base >= IMAGE_VISION_CANDIDATE_FLOOR);
});

test("ordinary approved image does NOT receive identity bonus", () => {
  const candidate: ImageCandidate = {
    url: APPROVED_HOST,
    sourceUrl: null,
    sourceType: "approved",
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg"
  };
  const base = scoreImageCandidateBase(candidate);
  assert.equal(base, IMAGE_SCORE.approvedSource + IMAGE_SCORE.largeImage);
  assert.ok(base < IMAGE_VISION_CANDIDATE_FLOOR);
});

test("SearXNG-style FWGS URL without identityMatched does not get identity bonus", () => {
  const candidate: ImageCandidate = {
    url: FWGS_F1_1200,
    sourceUrl: null,
    sourceType: "approved",
    width: 800,
    height: 800,
    mimeType: "image/jpeg"
  };
  const base = scoreImageCandidateBase(candidate);
  assert.equal(base, IMAGE_SCORE.approvedSource);
  assert.ok(base < IMAGE_VISION_CANDIDATE_FLOOR);
});

test("wrong / partial PLCB must not validate or receive identityMatched scoring", () => {
  assert.equal(validateFwgsImageUrl(FWGS_WRONG, PLCB), false);
  assert.equal(
    validateFwgsImageUrl(
      `https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/00000476_F1.jpg&height=1200&width=1200`,
      PLCB
    ),
    false
  );
  const candidate: ImageCandidate = {
    url: FWGS_WRONG,
    sourceUrl: null,
    sourceType: "approved",
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg"
  };
  assert.equal(
    scoreImageCandidateBase(candidate),
    IMAGE_SCORE.approvedSource + IMAGE_SCORE.largeImage
  );
});

test("global resolution and acceptance thresholds remain unchanged", () => {
  assert.equal(IMAGE_MIN_WIDTH, 600);
  assert.equal(IMAGE_MIN_HEIGHT, 600);
  assert.equal(IMAGE_VISION_CANDIDATE_FLOOR, 40);
  assert.equal(IMAGE_ACCEPTANCE_THRESHOLD, 75);
  assert.equal(IMAGE_SCORE.exactIdentityMatch, 30);
  assert.equal(IMAGE_SCORE.approvedSource, 15);
});

test("browser fallback success alone does not auto-accept; vision can still reject", () => {
  const candidate: ImageCandidate = {
    url: FWGS_F1_1200,
    sourceUrl: `https://www.finewineandgoodspirits.com/product/${PLCB}`,
    sourceType: "approved",
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg",
    identityMatched: true
  };
  const rejected = evaluateCandidate(candidate, wrongVision);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.rejectionReason, "wrong_product");
  const accepted = evaluateCandidate(candidate, cleanVision);
  assert.equal(accepted.rejected, false);
  assert.ok(accepted.score >= IMAGE_ACCEPTANCE_THRESHOLD);
  assert.equal(
    accepted.score,
    IMAGE_SCORE.approvedSource
      + IMAGE_SCORE.exactIdentityMatch
      + IMAGE_SCORE.largeImage
      + IMAGE_SCORE.cleanProductPhoto
  );
});

test("Captain Morgan regression: blocked direct probe + higher-res Figranium bytes reach vision and can accept", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("www.finewineandgoodspirits.com")) {
      return new Response("akamai deny", { status: 403 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  let visionSawBase64 = false;
  try {
    const result = await executeImageEnrichment(captainCandidate(), {
      searchImageHits: async () => [],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      extractFwgsPlcbImages: async () => ({
        matched: true,
        plcbItem: PLCB,
        imageUrls: [FWGS_F1],
        primaryImageUrl: FWGS_F1,
        extractionSource: "embedded_json"
      }),
      fetchFwgsImageViaFigranium: async (imageUrl) => {
        assert.equal(imageUrl, FWGS_F1_1200);
        return figraniumOk(png, 1200, 1200, imageUrl);
      },
      verifyImage: async (req) => {
        visionSawBase64 = Boolean(req.imageBase64 && req.imageBase64.length > 0);
        return cleanVision;
      }
    });

    const candidateStage = result.diagnostics.stages.find((s) => s.stage === "candidates");
    assert.ok(candidateStage, "candidates stage should exist");
    assert.equal(candidateStage?.status, "ok");
    assert.ok(
      String(candidateStage?.reason ?? "").includes("direct_fwgs_image_fetch_blocked")
    );
    assert.ok(
      String(candidateStage?.reason ?? "").includes("figranium_browser_fetch_succeeded")
      || String(candidateStage?.reason ?? "").includes("fwgs_image_discovered_via_figranium")
    );
    assert.ok(result.evaluated.length > 0, "candidate should reach normal scoring");
    const evaluated =
      result.evaluated.find((item) => item.url === FWGS_F1_1200)
      ?? result.evaluated.find((item) => item.url.includes("000004766_F1.jpg"));
    assert.ok(evaluated, "FWGS F1 (preferably 1200 rendition) should be evaluated");
    assert.equal(evaluated?.width, 1200);
    assert.equal(evaluated?.height, 1200);
    assert.equal(evaluated?.identityMatched, true);
    assert.notEqual(evaluated?.rejectionReason, "fetch_failed");
    assert.notEqual(evaluated?.rejectionReason, "low_resolution");
    assert.notEqual(evaluated?.rejectionReason, "below_vision_floor");
    assert.ok(visionSawBase64, "vision should receive recovered base64 bytes");
    assert.equal(result.selected?.url, FWGS_F1_1200);
    assert.ok((result.selected?.score ?? 0) >= IMAGE_ACCEPTANCE_THRESHOLD);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Figranium failure leaves image enrichment without a selected FWGS image", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403 })) as typeof fetch;
  try {
    const result = await executeImageEnrichment(captainCandidate(), {
      searchImageHits: async () => [
        {
          url: FWGS_F1,
          sourceUrl: `https://www.finewineandgoodspirits.com/product/${PLCB}`
        }
      ],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      fetchFwgsImageViaFigranium: async () => ({ ok: false, reason: "figranium_error" }),
      verifyImage: async () => cleanVision
    });
    assert.equal(result.selected, null);
    assert.ok(
      result.diagnostics.noResultReason === "source_fetch_failed"
      || result.diagnostics.noResultReason === "all_image_candidates_rejected"
      || result.diagnostics.noResultReason === "no_image_candidates"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
