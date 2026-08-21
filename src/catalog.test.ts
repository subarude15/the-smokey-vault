import assert from "node:assert/strict";
import { test } from "node:test";
import { parseList, parseTagInput, serializeList, spiritFamilyFromLabel } from "./catalog.js";

test("parseTagInput strips hashes and dedupes", () => {
  assert.deepEqual(parseTagInput("#irish #summer irish #rare"), ["irish", "summer", "rare"]);
});

test("parseList reads JSON or hashtags", () => {
  assert.deepEqual(parseList('["Peat","Vanilla"]'), ["Peat", "Vanilla"]);
  assert.deepEqual(parseList("#peat vanilla"), ["peat", "vanilla"]);
});

test("serializeList round-trips unique values", () => {
  assert.equal(serializeList(["Peat", "peat", " Oak "]), '["Peat","Oak"]');
});

test("spiritFamilyFromLabel lifts whiskey types into Whiskey family", () => {
  assert.deepEqual(spiritFamilyFromLabel("Bourbon"), { family: "Whiskey", type: "Bourbon" });
  assert.deepEqual(spiritFamilyFromLabel("Irish"), { family: "Whiskey", type: "Irish" });
  assert.deepEqual(spiritFamilyFromLabel("Corn whiskey"), { family: "Whiskey", type: "Corn whiskey" });
  assert.deepEqual(spiritFamilyFromLabel("Whiskey", "Rye"), { family: "Whiskey", type: "Rye" });
  assert.equal(spiritFamilyFromLabel("London Dry Gin").family, "Gin");
  assert.equal(spiritFamilyFromLabel("Mixer").family, "Mixer");
});
