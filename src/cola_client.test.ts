import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barcodeVariants,
  ean13Form,
  expandUpcE,
  mapColaToSchema,
  mapToSpiritCategory,
  mapToSpiritType,
  normalizeAbv,
  normalizeUpc,
  parseVolumeMl,
  productToInventoryFields,
  resetColaBurst,
  searchByBarcode,
  upcAForm,
  upcCheckDigit,
  ColaQuotaError
} from "./cola_client.js";

test("11-digit codes pad to 12 without inventing a check digit", () => {
  assert.equal(normalizeUpc("80686000891"), "080686000891");
  assert.equal(upcAForm("80686000891"), "080686000891");
  assert.equal(ean13Form("80686000891"), "0080686000891");
});

test("normalizeUpc pads UPC-A, keeps EAN-13, and expands UPC-E", () => {
  assert.equal(normalizeUpc("8066095702"), "008066095702");
  assert.equal(normalizeUpc("0123456789012"), "0123456789012");
  assert.equal(normalizeUpc("0-08066-09570-2"), "008066095702");
  const expanded = expandUpcE("04252614");
  assert.equal(expanded.length, 12);
  assert.equal(normalizeUpc("04252614"), expanded);
  assert.equal(upcAForm("04252614"), expanded);
  assert.equal(ean13Form("04252614"), `0${expanded}`);
});

test("barcodeVariants covers UPC-A, EAN-13 twins, and expanded UPC-E", () => {
  const variants = barcodeVariants("008066095702");
  assert.ok(variants.includes("008066095702"));
  assert.ok(variants.includes("08066095702") || variants.includes("8066095702"));
  const upcE = barcodeVariants("04252614");
  assert.ok(upcE.includes(expandUpcE("04252614")));
});

test("UPC-E expansion produces a 12-digit code with a valid check digit", () => {
  const expanded = expandUpcE("04252614");
  assert.equal(expanded.length, 12);
  assert.equal(expanded.slice(-1), upcCheckDigit(expanded.slice(0, 11)));
});

test("normalizeAbv and parseVolumeMl read OCR strings", () => {
  assert.equal(normalizeAbv("45.2%"), 45.2);
  assert.equal(normalizeAbv(""), null);
  assert.equal(parseVolumeMl("750 ml"), 750);
  assert.equal(parseVolumeMl("1L"), 1000);
  assert.equal(parseVolumeMl("1.75 L"), 1750);
});

test("mapToSpiritCategory keeps vault select options", () => {
  assert.equal(mapToSpiritCategory("Kentucky Straight Bourbon Whiskey"), "Whiskey");
  assert.equal(mapToSpiritType("Kentucky Straight Bourbon Whiskey"), "Bourbon");
  assert.equal(mapToSpiritCategory("Islay Single Malt Scotch"), "Whiskey");
  assert.equal(mapToSpiritType("Islay Single Malt Scotch"), "Scotch");
  assert.equal(mapToSpiritCategory("London Dry Gin"), "Gin");
});

test("mapColaToSchema plus inventory fields keep upc and image", () => {
  const product = mapColaToSchema("008066095702", {
    ttb_id: "TTB-1",
    brand_name: "Eagle Rare",
    product_name: "Eagle Rare 10 Year",
    product_type: "DISTILLED SPIRITS",
    derived_subcategory: "Spirits > Whiskey > Bourbon"
  }, {
    ttb_id: "TTB-1",
    ocr_abv: "45",
    ocr_volume: "750 ml",
    images: [{ image_type: "front", image_url: "https://example.com/label.jpg" }]
  });
  assert.equal(product.upc, "008066095702");
  assert.equal(product.image_url, "https://example.com/label.jpg");
  assert.equal(product.abv, 45);
  const fields = productToInventoryFields(product);
  assert.equal(fields.upc, "008066095702");
  assert.equal(fields.image_url, "https://example.com/label.jpg");
  assert.equal(fields.category, "Whiskey");
  assert.equal(fields.sub_category, "Bourbon");
});

test("a live barcode search that hits the burst cap throws quota without sleeping", async () => {
  const previous = process.env.COLA_API_KEY;
  process.env.COLA_API_KEY = "unit-test-key";
  resetColaBurst();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
  const started = Date.now();
  try {
    for (let i = 0; i < 10; i++) await searchByBarcode("008066095702");
    await assert.rejects(() => searchByBarcode("008066095702"), (error: unknown) => error instanceof ColaQuotaError);
    assert.ok(Date.now() - started < 4000, "live scans must not wait out the burst window");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous == null) delete process.env.COLA_API_KEY;
    else process.env.COLA_API_KEY = previous;
    resetColaBurst();
  }
});
