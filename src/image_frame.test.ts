import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp01, cropIsDefault, cropRect } from "./image_frame.js";

test("a matching 4:3 photo fills the crew frame with no crop", () => {
  const crop = cropRect(4000, 3000, 4 / 3, 1, 0.5, 0.5);
  assert.equal(crop.sx, 0);
  assert.equal(crop.sy, 0);
  assert.equal(crop.sw, 4000);
  assert.equal(crop.sh, 3000);
});

test("a landscape photo takes a centered square for the gallery tile", () => {
  const crop = cropRect(4000, 2000, 1, 1, 0.5, 0.5);
  assert.equal(crop.sw, 2000);
  assert.equal(crop.sh, 2000);
  assert.equal(crop.sx, 1000);
  assert.equal(crop.sy, 0);
});

test("a portrait photo takes a centered 4:3 window for a crew card", () => {
  const crop = cropRect(3000, 4000, 4 / 3, 1, 0.5, 0.5);
  assert.equal(crop.sw, 3000);
  assert.ok(Math.abs(crop.sh - 2250) < 0.01);
  assert.equal(crop.sx, 0);
  assert.ok(crop.sy > 800 && crop.sy < 900);
});

test("panning left uses the start of the overflow", () => {
  const crop = cropRect(4000, 2000, 1, 1, 0, 0.5);
  assert.equal(crop.sx, 0);
  assert.equal(crop.sw, 2000);
});

test("zoom 2 tightens the window around the same focal point", () => {
  const wide = cropRect(4000, 2000, 1, 2, 0.5, 0.5);
  assert.equal(wide.sw, 1000);
  assert.equal(wide.sh, 1000);
  assert.equal(wide.sx, 1500);
});

test("clamp01 keeps pan handles inside the photo", () => {
  assert.equal(clamp01(-2), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(clamp01(Number.NaN), 0.5);
});

test("the default frame is an untouched center crop", () => {
  assert.equal(cropIsDefault(1, 0.5, 0.5), true);
  assert.equal(cropIsDefault(1.2, 0.5, 0.5), false);
  assert.equal(cropIsDefault(1, 0.2, 0.5), false);
});
