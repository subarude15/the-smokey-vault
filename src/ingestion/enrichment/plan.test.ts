import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIDENCE,
  candidateFromProduct,
  field,
  mergeField,
  type BottleCandidate,
  type FieldConflict
} from "../candidate/index.js";
import {
  ENRICH_BELOW,
  IDENTITY_FIELDS,
  OPTIONAL_CONTENT_FIELDS,
  TRUSTED_MIN,
  planEnrichment
} from "./index.js";

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
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
    origin: "Kentucky",
    approval_date: null,
    proof: 90,
    ...overrides
  };
}

function fullyIdentified(): BottleCandidate {
  return candidateFromProduct(baseProduct(), "vault");
}

test("fully identified bottle produces no required identity tasks", () => {
  const plan = planEnrichment(fullyIdentified());
  assert.equal(plan.identified, true);
  assert.equal(plan.needsReview, false);
  const required = plan.tasks.filter((task) => task.priority === "required");
  assert.deepEqual(required, []);
  for (const name of IDENTITY_FIELDS) {
    assert.ok(!plan.tasks.some((task) => task.field === name));
  }
});

test("missing name prevents identified", () => {
  const candidate = fullyIdentified();
  candidate.name = field(null, "unknown");
  const plan = planEnrichment(candidate);
  assert.equal(plan.identified, false);
  const nameTask = plan.tasks.find((task) => task.field === "name");
  assert.ok(nameTask);
  assert.equal(nameTask?.priority, "required");
});

test("missing optional tasting notes does NOT prevent identified", () => {
  const plan = planEnrichment(fullyIdentified());
  assert.equal(plan.identified, true);
  const tasting = plan.tasks.find((task) => task.field === "tasting_notes");
  assert.ok(tasting);
  assert.equal(tasting?.priority, "optional");
  assert.ok((OPTIONAL_CONTENT_FIELDS as readonly string[]).includes("tasting_notes"));
});

test("missing image does NOT prevent identified", () => {
  const plan = planEnrichment(fullyIdentified());
  assert.equal(plan.identified, true);
  const image = plan.tasks.find((task) => task.field === "image");
  assert.ok(image);
  assert.equal(image?.priority, "optional");
});

test("missing recommended metadata creates enrichment tasks but keeps identity", () => {
  const candidate = candidateFromProduct(baseProduct({
    abv: null,
    proof: null,
    volume_ml: null,
    origin: null,
    ttb_id: null
  }), "fwgs");
  const plan = planEnrichment(candidate);
  assert.equal(plan.identified, true);
  for (const fieldName of ["abv", "proof", "volume_ml", "origin", "ttb_id"] as const) {
    const task = plan.tasks.find((t) => t.field === fieldName);
    assert.ok(task, `expected task for ${fieldName}`);
    assert.equal(task?.priority, "recommended");
  }
  assert.ok(!plan.tasks.some((task) => task.priority === "required"));
});

test("low-confidence fields can be scheduled for enrichment", () => {
  const candidate = fullyIdentified();
  candidate.abv = field(40, "llm");
  assert.ok(candidate.abv.confidence < ENRICH_BELOW);
  assert.ok(candidate.abv.confidence < TRUSTED_MIN);
  const plan = planEnrichment(candidate);
  assert.equal(plan.identified, true);
  const abvTask = plan.tasks.find((task) => task.field === "abv");
  assert.ok(abvTask);
  assert.equal(abvTask?.priority, "recommended");
  assert.match(abvTask?.reason ?? "", /confidence/);
});

test("trusted identity conflicts set needsReview", () => {
  const vaultName = field("Eagle Rare", "vault");
  const colaName = field("Eagle Rare 10 Year", "cola");
  assert.ok(vaultName.confidence >= TRUSTED_MIN);
  assert.ok(colaName.confidence >= TRUSTED_MIN);
  const merged = mergeField(vaultName, colaName, "name");
  assert.ok(merged.conflict);

  const candidate = fullyIdentified();
  candidate.name = merged.field;
  const plan = planEnrichment(candidate, { conflicts: [merged.conflict as FieldConflict] });
  assert.equal(plan.needsReview, true);
  assert.equal(plan.reviewConflicts.length, 1);
  assert.equal(plan.reviewConflicts[0]?.field, "name");
  // Identity still holds on the kept vault value.
  assert.equal(plan.identified, true);
});

test("a mostly unknown candidate produces the expected required tasks", () => {
  const candidate = candidateFromProduct({
    upc: "",
    name: "",
    brand: "",
    category: "",
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
  }, "unknown");
  const plan = planEnrichment(candidate);
  assert.equal(plan.identified, false);
  for (const name of IDENTITY_FIELDS) {
    const task = plan.tasks.find((t) => t.field === name);
    assert.ok(task, `required task for ${name}`);
    assert.equal(task?.priority, "required");
  }
  assert.ok(plan.tasks.some((t) => t.field === "tasting_notes" && t.priority === "optional"));
  assert.ok(plan.tasks.some((t) => t.field === "image" && t.priority === "optional"));
});

test("low-confidence identity field blocks identified and schedules required enrichment", () => {
  const candidate = fullyIdentified();
  candidate.product_type = field("maybe spirit", "llm");
  assert.equal(candidate.product_type.confidence, CONFIDENCE.LOW);
  const plan = planEnrichment(candidate);
  assert.equal(plan.identified, false);
  const task = plan.tasks.find((t) => t.field === "product_type");
  assert.equal(task?.priority, "required");
});

test("non-identity conflicts do not set needsReview", () => {
  const a = field(40, "fwgs");
  const b = field(45, "cola");
  const merged = mergeField(a, b, "abv");
  assert.ok(merged.conflict);
  const plan = planEnrichment(fullyIdentified(), { conflicts: [merged.conflict as FieldConflict] });
  assert.equal(plan.needsReview, false);
  assert.deepEqual(plan.reviewConflicts, []);
});
