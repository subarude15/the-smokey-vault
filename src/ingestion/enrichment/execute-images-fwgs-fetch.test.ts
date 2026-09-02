/**
 * FWGS Figranium image-fetch fallback wiring for image enrichment.
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
import type { FwgsImageFetchOutcome } from "../../fwgs-figranium.js";

const PLCB = "000004766";
const FWGS_F1 =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475";
const FWGS_WRONG =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000008865_F1.jpg&height=475&width=475";
const OTHER_HOST = "https://cdn.example.com/captain.png";

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
  height = 1200
): FwgsImageFetchOutcome {
  return {
    ok: true,
    image: {
      plcbItem: PLCB,
      sourceUrl: FWGS_F1,
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

test("reachable FWGS image does not invoke Figranium fetch fallback", async () => {
  const png = makePng(800, 800);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () =>
    new Response(png, {
      status: 200,
      headers: { "Content-Type": "image/png" }
    })) as typeof fetch;
  try {
    const ok = await probeImageMetaWithFwgsFallback(FWGS_F1, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async () => {
        fetchCalls += 1;
        return { ok: false, reason: "figranium_error" };
      }
    });
    assert.equal(ok.reachable, true);
    assert.deepEqual(ok.probeDetails, ["direct_probe_ok"]);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct FWGS fetch failure invokes Figranium fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403 })) as typeof fetch;
  let fetchCalls = 0;
  const png = makePng(800, 800);
  try {
    const meta = await probeImageMetaWithFwgsFallback(FWGS_F1, {
      plcbItem: PLCB,
      fetchFwgsImageViaFigranium: async (imageUrl, plcbItem) => {
        fetchCalls += 1;
        assert.equal(imageUrl, FWGS_F1);
        assert.equal(plcbItem, PLCB);
        return figraniumOk(png, 800, 800);
      }
    });
    assert.equal(fetchCalls, 1);
    assert.equal(meta.reachable, true);
    assert.ok(meta.probeDetails?.includes("direct_probe_http_rejected"));
    assert.ok(meta.probeDetails?.includes("figranium_fetch_fallback_attempted"));
    assert.ok(meta.probeDetails?.includes("figranium_fetch_fallback_ok"));
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
    const meta = await probeImageMetaWithFwgsFallback(
      "https://www.totalwine.com/media/captain.jpg",
      {
        plcbItem: PLCB,
        fetchFwgsImageViaFigranium: async () => {
          fetchCalls += 1;
          return { ok: false, reason: "figranium_error" };
        }
      }
    );
    assert.equal(meta.reachable, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Captain Morgan regression: blocked direct probe + Figranium F1 bytes continue through scoring/verification", async () => {
  const png = makePng(1200, 1200);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("finewineandgoodspirits.com")) {
      return new Response("akamai deny", { status: 403 });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await executeImageEnrichment(captainCandidate(), {
      searchImageHits: async () => [
        {
          url: FWGS_F1,
          sourceUrl: `https://www.finewineandgoodspirits.com/product/${PLCB}`,
          mimeType: "image/jpeg"
        }
      ],
      searchWebHits: async () => [],
      fetchPageHtml: async () => null,
      fetchFwgsImageViaFigranium: async () => figraniumOk(png),
      verifyImage: async () => cleanVision
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
    const evaluated = result.evaluated.find((item) => item.url === FWGS_F1);
    assert.ok(evaluated, "FWGS F1 should be evaluated");
    assert.equal(evaluated?.width, 1200);
    assert.equal(evaluated?.height, 1200);
    assert.notEqual(evaluated?.rejectionReason, "fetch_failed");
    // Approved FWGS sources score below the vision floor today (15+10 < 40), so
    // selection may still fail — this regression proves bytes were recovered and scored.
    assert.ok(
      evaluated?.rejectionReason === "below_vision_floor"
      || evaluated?.rejectionReason === "score_below_threshold"
      || result.selected?.url === FWGS_F1
    );
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
