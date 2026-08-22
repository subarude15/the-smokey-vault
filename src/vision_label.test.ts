import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVisionLabel } from "./vision_label.js";

test("parseVisionLabel reads markdown-wrapped bottle JSON", () => {
  const parsed = parseVisionLabel(`\`\`\`json
{"name":"Eagle Rare 10 Year","brand":"Buffalo Trace","category":"Kentucky Straight Bourbon","abv":45,"volume_ml":750,"upc":"080244009365","product_type":"spirit"}
\`\`\``);
  assert.equal(parsed.name, "Eagle Rare 10 Year");
  assert.equal(parsed.brand, "Buffalo Trace");
  assert.equal(parsed.abv, 45);
  assert.equal(parsed.volume_ml, 750);
  assert.equal(parsed.upc, "080244009365");
  assert.equal(parsed.product_type, "spirit");
});

test("parseVisionLabel fills beer category and ignores empty fields", () => {
  const parsed = parseVisionLabel('{"name":"Nugget Nectar","brand":"Tröegs","abv":"7.5%","volume_ml":"12 oz","upc":"","product_type":"beer"}');
  assert.equal(parsed.category, "Beer");
  assert.equal(parsed.abv, 7.5);
  assert.equal(parsed.volume_ml, 355);
  assert.equal(parsed.upc, "");
  assert.equal(parsed.product_type, "beer");
});

test("parseVisionLabel rejects text with no JSON object", () => {
  assert.throws(() => parseVisionLabel("I cannot read this image"), /Could not read that label/);
});
