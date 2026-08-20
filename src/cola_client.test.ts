import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barcodeVariants,
  mapColaToSchema,
  mapToSpiritCategory,
  normalizeAbv,
  normalizeUpc,
  parseVolumeMl,
  productToInventoryFields
} from "./cola_client.js";

test("normalizeUpc pads UPC-A and keeps EAN-13", () => {
  assert.equal(normalizeUpc("8066095702"), "008066095702");
  assert.equal(normalizeUpc("0123456789012"), "0123456789012");
  assert.equal(normalizeUpc("0-08066-09570-2"), "008066095702");
});

test("barcodeVariants covers UPC-A and EAN-13 twins", () => {
  const variants = barcodeVariants("008066095702");
  assert.ok(variants.includes("008066095702"));
  assert.ok(variants.includes("08066095702") || variants.includes("8066095702"));
});

test("normalizeAbv and parseVolumeMl read OCR strings", () => {
  assert.equal(normalizeAbv("45.2%"), 45.2);
  assert.equal(normalizeAbv(""), null);
  assert.equal(parseVolumeMl("750 ml"), 750);
  assert.equal(parseVolumeMl("1L"), 1000);
  assert.equal(parseVolumeMl("1.75 L"), 1750);
});

test("mapToSpiritCategory keeps vault select options", () => {
  assert.equal(mapToSpiritCategory("Kentucky Straight Bourbon Whiskey"), "Bourbon");
  assert.equal(mapToSpiritCategory("Islay Single Malt Scotch"), "Scotch");
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
  assert.equal(fields.category, "Bourbon");
});
