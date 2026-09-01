import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIDENCE,
  SOURCE_CONFIDENCE,
  candidateFromLookup,
  candidateFromProduct,
  confidenceForSource,
  field,
  fieldSourceFromLookupSource,
  isUnresolvedField,
  mergeCandidates,
  mergeField,
  unresolvedFields,
  valuesDisagree
} from "./index.js";

test("confidence bands are discrete plateaus keyed by source", () => {
  assert.equal(confidenceForSource("vault"), CONFIDENCE.VERY_HIGH);
  assert.equal(confidenceForSource("barcode_cache"), CONFIDENCE.VERY_HIGH);
  assert.equal(confidenceForSource("user"), CONFIDENCE.VERY_HIGH);
  assert.equal(confidenceForSource("iowa"), CONFIDENCE.HIGH);
  assert.equal(confidenceForSource("fwgs"), CONFIDENCE.HIGH);
  assert.equal(confidenceForSource("cola"), CONFIDENCE.HIGH);
  assert.equal(confidenceForSource("vision"), CONFIDENCE.HIGH);
  assert.equal(confidenceForSource("open_food_facts"), CONFIDENCE.MEDIUM);
  assert.equal(confidenceForSource("upcitemdb"), CONFIDENCE.MEDIUM);
  assert.equal(confidenceForSource("web"), CONFIDENCE.MEDIUM);
  assert.equal(confidenceForSource("llm"), CONFIDENCE.LOW);
  assert.equal(SOURCE_CONFIDENCE.unknown, CONFIDENCE.LOW);
});

test("LookupSource chips map onto ProductFieldSource without inventing scores", () => {
  assert.equal(fieldSourceFromLookupSource("vault"), "vault");
  assert.equal(fieldSourceFromLookupSource("cache"), "cola_cache");
  assert.equal(fieldSourceFromLookupSource("beer_cache"), "beer_cache");
  assert.equal(fieldSourceFromLookupSource("iowa"), "iowa");
  assert.equal(fieldSourceFromLookupSource("cola_cloud"), "cola");
  assert.equal(fieldSourceFromLookupSource("openfoodfacts"), "open_food_facts");
  assert.equal(fieldSourceFromLookupSource("label"), "vision");
  assert.equal(fieldSourceFromLookupSource("not_found"), "unknown");
});

test("higher-confidence data is not overwritten by lower-confidence data", () => {
  const vaultName = field("Buffalo Trace", "vault");
  const webName = field("Buffalo Trace Bourbon", "web");
  const merged = mergeField(vaultName, webName, "name");
  assert.equal(merged.field.value, "Buffalo Trace");
  assert.equal(merged.field.source, "vault");
  assert.equal(merged.overwritten, false);
  assert.ok(merged.conflict);
  assert.equal(merged.conflict?.incoming.source, "web");
});

test("a null field can be filled by a trusted later source", () => {
  const emptyAbv = field<number>(null, "unknown");
  assert.equal(isUnresolvedField(emptyAbv), true);
  const colaAbv = field(45, "cola");
  const merged = mergeField(emptyAbv, colaAbv, "abv");
  assert.equal(merged.overwritten, true);
  assert.equal(merged.field.value, 45);
  assert.equal(merged.field.source, "cola");
  assert.equal(merged.conflict, undefined);
});

test("conflicting equal-confidence values are detected and first wins", () => {
  const a = field("Eagle Rare", "fwgs");
  const b = field("Eagle Rare 10 Year", "cola");
  assert.equal(a.confidence, b.confidence);
  assert.equal(valuesDisagree(a.value, b.value), true);
  const merged = mergeField(a, b, "name");
  assert.equal(merged.field.value, "Eagle Rare");
  assert.ok(merged.conflict);
});

test("unknown/null remains valid and is not an ingestion failure", () => {
  const miss = candidateFromLookup({
    source: "not_found",
    upc: "012345678901",
    product: { upc: "012345678901", name: "", brand: "", category: "Spirits", abv: 0, image_url: "", notes: "", fill_level: 100, stock_count: 1, volume_ml: 750 },
    reason: "no_catalog",
    message: "No catalog match."
  });
  assert.equal(miss.primarySource, "unknown");
  assert.ok(unresolvedFields(miss).includes("name"));
  assert.ok(unresolvedFields(miss).includes("brand"));
  assert.equal(miss.upc.value, "012345678901");
  // Building a miss candidate must not throw; unresolved is expected.
  assert.ok(isUnresolvedField(miss.abv) || miss.abv.value === 0);
});

test("candidateFromProduct stamps one source across filled fields", () => {
  const candidate = candidateFromProduct({
    upc: "080686000891",
    name: "Buffalo Trace",
    brand: "Buffalo Trace",
    category: "Bourbon",
    abv: 45,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: 750,
    product_type: "DISTILLED SPIRITS",
    ttb_id: "TTB-1",
    origin: "USA",
    approval_date: null
  }, "fwgs");
  assert.equal(candidate.name.value, "Buffalo Trace");
  assert.equal(candidate.name.source, "fwgs");
  assert.equal(candidate.name.confidence, CONFIDENCE.HIGH);
  assert.equal(candidate.proof.value, null);
  assert.ok(unresolvedFields(candidate).includes("proof"));
});

test("mergeCandidates fills gaps without clobbering vault fields", () => {
  const vault = candidateFromProduct({
    upc: "080686000891",
    name: "Buffalo Trace",
    brand: "Buffalo Trace",
    category: "Bourbon",
    abv: null,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: null,
    product_type: null,
    ttb_id: null,
    origin: null,
    approval_date: null
  }, "vault");
  const cola = candidateFromProduct({
    upc: "080686000891",
    name: "Different Name From COLA",
    brand: "Buffalo Trace",
    category: "Bourbon Whiskey",
    abv: 45,
    image_url: null,
    fill_level_percent: 100,
    bottle_count: 1,
    notes: null,
    volume_ml: 750,
    product_type: "DISTILLED SPIRITS",
    ttb_id: "TTB-1",
    origin: "Kentucky",
    approval_date: null
  }, "cola");

  const { candidate, conflicts, overwritten } = mergeCandidates(vault, cola);
  assert.equal(candidate.name.value, "Buffalo Trace", "vault name stays");
  assert.ok(conflicts.some((c) => c.field === "name"));
  assert.equal(candidate.abv.value, 45);
  assert.ok(overwritten.includes("abv"));
  assert.equal(candidate.volume_ml.value, 750);
  assert.equal(candidate.ttb_id.value, "TTB-1");
});

test("empty strings are unresolved, not zero-confidence product names", () => {
  const blank = field("", "llm");
  assert.equal(blank.value, null);
  assert.equal(blank.confidence, CONFIDENCE.NONE);
  assert.equal(isUnresolvedField(blank), true);
});
