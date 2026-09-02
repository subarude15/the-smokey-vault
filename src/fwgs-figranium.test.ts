/**
 * FWGS Figranium adapter unit tests (mocked Figranium runs).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { z } from "zod";
import { figraniumRunTask } from "./figranium.js";
import {
  extractFwgsPlcbImages,
  filterValidatedFwgsImageUrls,
  fwgsFigraniumProductToFwgs,
  fwgsPdpUrlForItem,
  isFwgsFigraniumConfigured,
  normalizePlcbItem,
  parseFwgsFigraniumImages,
  parseFwgsFigraniumProduct,
  resolveFwgsPlcbProduct,
  resolveFwgsPlcbProductWithImages,
  validateFwgsImageUrl
} from "./fwgs-figranium.js";

const originalFetch = globalThis.fetch;
const envKeys = [
  "FIGRANIUM_API_KEY",
  "FIGRANIUM_BASE_URL",
  "FIGRANIUM_FWGS_RESOLVER_TASK_ID",
  "FIGRANIUM_FWGS_IMAGE_TASK_ID"
] as const;
const savedEnv = new Map<string, string | undefined>();

const VALID_IMAGE =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475";
const VALID_IMAGE_B =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_B1.jpg&height=475&width=475";

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

function configureFwgsImageEnv() {
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID = "task_images";
}

afterEach(() => {
  restoreEnv();
});

test("normalizePlcbItem zero-pads digit-only codes", () => {
  assert.equal(normalizePlcbItem("4766"), "000004766");
  assert.equal(normalizePlcbItem("000004766"), "000004766");
  assert.equal(fwgsPdpUrlForItem("4766"), "https://www.finewineandgoodspirits.com/product/000004766");
});

test("normalizePlcbItem rejects malformed PLCB input", () => {
  assert.equal(normalizePlcbItem(""), "");
  assert.equal(normalizePlcbItem("  "), "");
  assert.equal(normalizePlcbItem("4766x"), "");
  assert.equal(normalizePlcbItem("sku-4766"), "");
  assert.equal(normalizePlcbItem("000004766-extra"), "");
  assert.equal(fwgsPdpUrlForItem("sku-4766"), "");
});

test("isFwgsFigraniumConfigured requires base URL, API key, and image task ID", () => {
  stashEnv();
  delete process.env.FIGRANIUM_API_KEY;
  delete process.env.FIGRANIUM_BASE_URL;
  delete process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID;
  assert.equal(isFwgsFigraniumConfigured(), false);

  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  assert.equal(isFwgsFigraniumConfigured(), false);

  process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID = "task_images";
  assert.equal(isFwgsFigraniumConfigured(), true);
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

test("parseFwgsFigraniumProduct rejects malformed schema", () => {
  assert.equal(parseFwgsFigraniumProduct({ matched: "yes" }), null);
  assert.equal(parseFwgsFigraniumProduct({ matched: true, imageUrls: "nope" }), null);
  assert.equal(parseFwgsFigraniumProduct(null), null);
});

test("parseFwgsFigraniumImages maps extractor payload and drops invalid hosts", () => {
  const hit = parseFwgsFigraniumImages({
    matched: true,
    plcbItem: "000004766",
    primaryImageUrl: VALID_IMAGE,
    imageUrls: [
      VALID_IMAGE,
      VALID_IMAGE_B,
      "https://cdn.example/F1.jpg"
    ],
    extractionSource: "embedded_json"
  });
  assert.ok(hit);
  assert.equal(hit.imageUrls.length, 2);
  assert.match(hit.primaryImageUrl ?? "", /_F1\./);
});

test("parseFwgsFigraniumImages rejects malformed schema", () => {
  assert.equal(
    parseFwgsFigraniumImages({
      matched: true,
      plcbItem: "000004766",
      imageUrls: "not-an-array",
      primaryImageUrl: null
    }),
    null
  );
});

test("validateFwgsImageUrl accepts FWGS product asset URLs", () => {
  assert.equal(validateFwgsImageUrl(VALID_IMAGE, "4766"), true);
  assert.equal(
    validateFwgsImageUrl(
      "https://www.finewineandgoodspirits.com/file/v1/products/000004766.jpg",
      "000004766"
    ),
    true
  );
});

test("validateFwgsImageUrl rejects wrong image host", () => {
  assert.equal(
    validateFwgsImageUrl(
      "https://cdn.example/products/000004766_F1.jpg",
      "000004766"
    ),
    false
  );
  assert.equal(
    validateFwgsImageUrl(
      "http://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg",
      "000004766"
    ),
    false
  );
});

test("validateFwgsImageUrl rejects wrong PLCB image", () => {
  assert.equal(
    validateFwgsImageUrl(
      "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000008865_F1.jpg&height=475&width=475",
      "000004766"
    ),
    false
  );
});

test("validateFwgsImageUrl rejects partial-number image mismatch", () => {
  assert.equal(
    validateFwgsImageUrl(
      "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/0000047661_F1.jpg",
      "000004766"
    ),
    false
  );
  assert.equal(
    validateFwgsImageUrl(
      "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/1000004766_F1.jpg",
      "000004766"
    ),
    false
  );
  assert.equal(
    validateFwgsImageUrl(
      "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/foo000004766_F1.jpg",
      "000004766"
    ),
    false
  );
});

test("filterValidatedFwgsImageUrls keeps only valid URLs", () => {
  const filtered = filterValidatedFwgsImageUrls(
    [
      VALID_IMAGE,
      "https://evil.example/products/000004766_F1.jpg",
      VALID_IMAGE_B,
      VALID_IMAGE
    ],
    "000004766"
  );
  assert.deepEqual(filtered, [VALID_IMAGE, VALID_IMAGE_B]);
});

test("resolveFwgsPlcbProduct calls resolver task with padded item + pdpUrl", async () => {
  stashEnv();
  configureFwgsImageEnv();
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

test("figraniumRunTask rejects malformed task data schema", async () => {
  stashEnv();
  configureFwgsImageEnv();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        outcome: "success",
        data: { matched: true, plcbItem: 4766 }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  const schema = z.object({
    matched: z.boolean(),
    plcbItem: z.string()
  });
  const result = await figraniumRunTask("task_images", { schema });
  assert.equal(result.kind, "invalid_response");
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

  candidate.proof.sourceItemId = "sku-4766";
  assert.equal(plcbItemFromCandidate(candidate), null);
});

test("extractFwgsPlcbImages validates image URLs from Figranium", async () => {
  stashEnv();
  configureFwgsImageEnv();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        outcome: "success",
        data: {
          matched: true,
          plcbItem: "000004766",
          primaryImageUrl: VALID_IMAGE,
          imageUrls: [VALID_IMAGE, "https://cdn.example/F1.jpg", VALID_IMAGE_B]
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )) as typeof fetch;

  const images = await extractFwgsPlcbImages("000004766");
  assert.ok(images?.matched);
  assert.equal(images?.imageUrls.length, 2);
  assert.equal(images?.primaryImageUrl, VALID_IMAGE);
});

test("resolveFwgsPlcbProductWithImages fills images when resolver returns none", async () => {
  stashEnv();
  configureFwgsImageEnv();
  process.env.FIGRANIUM_FWGS_RESOLVER_TASK_ID = "task_resolver";
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
          primaryImageUrl: VALID_IMAGE,
          imageUrls: [VALID_IMAGE, VALID_IMAGE_B]
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const hit = await resolveFwgsPlcbProductWithImages("000004766");
  assert.equal(calls, 2);
  assert.equal(hit?.primaryImageUrl, VALID_IMAGE);
  assert.equal(hit?.imageUrls.length, 2);
});
