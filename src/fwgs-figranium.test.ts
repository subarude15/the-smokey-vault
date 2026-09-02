/**
 * FWGS Figranium adapter unit tests (mocked Figranium runs).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  extractFwgsPlcbImages,
  fwgsFigraniumProductToFwgs,
  fwgsPdpUrlForItem,
  normalizePlcbItem,
  parseFwgsFigraniumImages,
  parseFwgsFigraniumProduct,
  resolveFwgsPlcbProduct,
  resolveFwgsPlcbProductWithImages
} from "./fwgs-figranium.js";

const originalFetch = globalThis.fetch;
const envKeys = [
  "FIGRANIUM_API_KEY",
  "FIGRANIUM_BASE_URL",
  "FIGRANIUM_FWGS_RESOLVER_TASK_ID",
  "FIGRANIUM_FWGS_IMAGE_TASK_ID"
] as const;
const savedEnv = new Map<string, string | undefined>();

function stashEnv() {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
}

function restoreEnv() {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
}

afterEach(() => {
  restoreEnv();
});

test("normalizePlcbItem zero-pads numeric codes", () => {
  assert.equal(normalizePlcbItem("4766"), "000004766");
  assert.equal(normalizePlcbItem("000004766"), "000004766");
  assert.equal(fwgsPdpUrlForItem("4766"), "https://www.finewineandgoodspirits.com/product/000004766");
});

test("parseFwgsFigraniumProduct maps resolver payload", () => {
  const hit = parseFwgsFigraniumProduct({
    matched: true,
    ambiguous: false,
    notFound: false,
    plcbItem: "000004766",
    productUrl: "https://www.finewineandgoodspirits.com/product/000004766",
    name: "Captain Morgan Original Spiced Rum",
    brand: "Captain Morgan",
    proof: 70,
    abv: null,
    volumeText: "1.75L",
    category: "Rum",
    subcategory: null,
    country: "United States",
    region: null,
    imageUrls: [],
    primaryImageUrl: null
  });
  assert.ok(hit);
  assert.equal(hit.matched, true);
  assert.equal(hit.name, "Captain Morgan Original Spiced Rum");
  assert.equal(hit.proof, 70);
  const fwgs = fwgsFigraniumProductToFwgs(hit);
  assert.ok(fwgs);
  assert.equal(fwgs.name, "Captain Morgan Original Spiced Rum");
  assert.equal(fwgs.volume_ml, 1750);
});

test("parseFwgsFigraniumImages maps extractor payload", () => {
  const hit = parseFwgsFigraniumImages({
    matched: true,
    plcbItem: "000004766",
    primaryImageUrl: "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475",
    imageUrls: [
      "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475",
      "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_B1.jpg&height=475&width=475"
    ],
    extractionSource: "embedded_json"
  });
  assert.ok(hit);
  assert.equal(hit.imageUrls.length, 2);
  assert.match(hit.primaryImageUrl ?? "", /_F1\./);
});

test("resolveFwgsPlcbProduct calls resolver task with padded item + pdpUrl", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_FWGS_RESOLVER_TASK_ID = "task_resolver";
  let url = "";
  let body = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    body = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        outcome: "success",
        data: {
          matched: true,
          ambiguous: false,
          notFound: false,
          plcbItem: "000004766",
          productUrl: "https://www.finewineandgoodspirits.com/product/000004766",
          name: "Captain Morgan Original Spiced Rum",
          brand: "Captain Morgan",
          proof: 70,
          abv: null,
          volumeText: "1.75L",
          category: "Rum",
          subcategory: null,
          country: "United States",
          region: null,
          imageUrls: [],
          primaryImageUrl: null
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const hit = await resolveFwgsPlcbProduct("4766");
  assert.ok(hit?.matched);
  assert.match(url, /task_resolver\/api$/);
  assert.match(body, /"plcbItem":"000004766"/);
  assert.match(body, /product\/000004766/);
  assert.equal(hit?.name, "Captain Morgan Original Spiced Rum");
});

test("plcbItemFromCandidate reads government provenance sourceItemId", async () => {
  const { plcbItemFromCandidate } = await import("./fwgs-figranium.js");
  const { field } = await import("./ingestion/candidate/index.js");
  const candidate = {
    primarySource: "plcb_spirits" as const,
    upc: field("087000201156", "plcb_spirits"),
    name: field("Captain Morgan Original Spiced Rum", "plcb_spirits"),
    brand: field("Captain Morgan", "plcb_spirits"),
    product_type: field(null, "unknown"),
    category: field("Rum", "plcb_spirits"),
    abv: field(null, "unknown"),
    proof: field(70, "plcb_spirits"),
    volume_ml: field(1750, "plcb_spirits"),
    origin: field("United States", "plcb_spirits"),
    ttb_id: field(null, "unknown")
  };
  candidate.proof.sourceItemId = "4766";
  assert.equal(plcbItemFromCandidate(candidate), "000004766");
});

test("resolveFwgsPlcbProductWithImages fills images when resolver returns none", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_FWGS_RESOLVER_TASK_ID = "task_resolver";
  process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID = "task_images";
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1;
    const url = String(input);
    if (url.includes("task_resolver")) {
      return new Response(
        JSON.stringify({
          outcome: "success",
          data: {
            matched: true,
            ambiguous: false,
            notFound: false,
            plcbItem: "000004766",
            productUrl: "https://www.finewineandgoodspirits.com/product/000004766",
            name: "Captain Morgan Original Spiced Rum",
            brand: "Captain Morgan",
            proof: 70,
            abv: null,
            volumeText: "1.75L",
            category: "Rum",
            subcategory: null,
            country: "United States",
            region: null,
            imageUrls: [],
            primaryImageUrl: null
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        outcome: "success",
        data: {
          matched: true,
          plcbItem: "000004766",
          primaryImageUrl: "https://cdn.example/F1.jpg",
          imageUrls: ["https://cdn.example/F1.jpg", "https://cdn.example/B1.jpg"]
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const hit = await resolveFwgsPlcbProductWithImages("000004766");
  assert.equal(calls, 2);
  assert.equal(hit?.primaryImageUrl, "https://cdn.example/F1.jpg");
  assert.equal(hit?.imageUrls.length, 2);

  const imagesOnly = await extractFwgsPlcbImages("000004766");
  assert.equal(imagesOnly?.primaryImageUrl, "https://cdn.example/F1.jpg");
});
