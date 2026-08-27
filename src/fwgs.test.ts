import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fwgsToSchema, isFwgsThin, parseFwgsHtml, parseFwgsHtmlAll } from "./fwgs.js";

const dir = dirname(fileURLToPath(import.meta.url));

test("parseFwgsHtml reads JSON-LD name, size, price, and photo", () => {
  const html = readFileSync(join(dir, "fixtures/fwgs-product.html"), "utf8");
  const hit = parseFwgsHtml(html);
  assert.ok(hit);
  assert.equal(hit.name, "Buffalo Trace Kentucky Straight Bourbon Whiskey");
  assert.equal(hit.brand, "Buffalo Trace");
  assert.equal(hit.volume_ml, 750);
  assert.equal(hit.price, "$27.99");
  assert.match(hit.image_url ?? "", /buffalo-trace\.jpg/);
  assert.equal(isFwgsThin(hit), false);
});

test("parseFwgsHtml reads a product tile when JSON-LD is missing", () => {
  const html = readFileSync(join(dir, "fixtures/fwgs-tile.html"), "utf8");
  const hit = parseFwgsHtml(html);
  assert.ok(hit);
  assert.match(hit.name, /Vietti Barolo/);
  assert.equal(hit.volume_ml, 750);
  assert.equal(hit.price, "$54.99");
  assert.match(hit.image_url ?? "", /^https:\/\/www\.finewineandgoodspirits\.com\//);
});

test("parseFwgsHtml ignores a product-request form instead of treating it as a hit", () => {
  const html = readFileSync(join(dir, "fixtures/fwgs-request-form.html"), "utf8");
  assert.equal(parseFwgsHtml(html), null);
  assert.equal(parseFwgsHtml('<meta property="og:title" content="Product Request Form">'), null);
});

test("parseFwgsHtml treats an empty search as a miss, not a throw", () => {
  const html = readFileSync(join(dir, "fixtures/fwgs-empty.html"), "utf8");
  assert.equal(parseFwgsHtml(html), null);
  assert.equal(parseFwgsHtml(""), null);
  assert.equal(parseFwgsHtml("<html><body>Akamai denied</body></html>"), null);
});

test("parseFwgsHtmlAll returns multiple product tiles", () => {
  const html = `
    <div class="product-tile">
      <span class="product-name">Buffalo Trace Bourbon</span>
      <span class="size">750 ml</span>
      <span>$27.99</span>
    </div>
    <div class="product-tile">
      <span class="product-name">Eagle Rare 10 Year</span>
      <span class="size">750 ml</span>
      <span>$42.99</span>
    </div>
  `;
  const hits = parseFwgsHtmlAll(html, 6);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.name, "Buffalo Trace Bourbon");
  assert.equal(hits[1]?.name, "Eagle Rare 10 Year");
});

test("a named FWGS hit without a photo is still usable, but missing volume is thin", () => {
  const named = parseFwgsHtml(`<script type="application/ld+json">{"@type":"Product","name":"Eagle Rare 10 Year","offers":{"price":"42.99"}}</script>`);
  assert.equal(named?.name, "Eagle Rare 10 Year");
  assert.equal(named?.image_url, null);
  assert.equal(isFwgsThin(named), true);
  const product = fwgsToSchema("080244009365", named!);
  assert.equal(product.name, "Eagle Rare 10 Year");
  assert.equal(product.image_url, null);
});
