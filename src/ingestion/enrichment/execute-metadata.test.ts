import assert from "node:assert/strict";
import { test } from "node:test";
import type { LookupResult } from "../../lookup-shared.js";
import {
  CONFIDENCE,
  candidateFromProduct,
  field,
  type BottleCandidate
} from "../candidate/index.js";
import { executeMetadataEnrichment } from "./execute-metadata.js";
import { buildPrompt, parseExtracted } from "./metadata-extract.js";
import { abvFromProof, proofFromAbv } from "./metadata-fields.js";
import { planEnrichment } from "./plan.js";
import { TRUSTED_MIN } from "./rules.js";

function product(overrides: Record<string, unknown> = {}) {
  return {
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
    product_type: "DISTILLED SPIRITS",
    ttb_id: null,
    origin: null,
    approval_date: null,
    proof: null,
    ...overrides
  };
}

function identifiedCandidate(overrides: Record<string, unknown> = {}, source: "vault" | "fwgs" | "cola" = "fwgs"): BottleCandidate {
  return candidateFromProduct(product(overrides), source);
}

test("missing ABV filled by a higher-confidence trusted catalog source", async () => {
  const candidate = identifiedCandidate();
  const plan = planEnrichment(candidate);
  assert.ok(plan.tasks.some((t) => t.field === "abv"));

  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({
      source: "cola_cloud",
      upc: "080686000891",
      table: "spirits",
      kind: "spirits",
      product: {
        upc: "080686000891",
        name: "Buffalo Trace",
        brand: "Buffalo Trace",
        abv: 45,
        product_type: "DISTILLED SPIRITS"
      }
    } satisfies LookupResult),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });

  assert.equal(result.candidate.abv.value, 45);
  assert.equal(result.candidate.abv.source, "cola");
  assert.ok(result.candidate.abv.confidence >= TRUSTED_MIN);
  assert.ok(result.completed.includes("abv"));
  assert.equal(planEnrichment(result.candidate).identified, true);
});

test("lower-confidence web value does not overwrite trusted catalog ABV", async () => {
  const candidate = identifiedCandidate({ abv: 45 }, "cola");
  assert.equal(candidate.abv.confidence, CONFIDENCE.HIGH);
  // Force abv onto the plan by dropping confidence artificially below ENRICH_BELOW... 
  // Actually trusted abv won't be in plan. Put a low-confidence abv that web tries to replace with wrong value,
  // while catalog has trusted — wait, catalog merge happens before web. Better: start with trusted cola abv,
  // and ensure web extract of different value does not overwrite when we force web path.
  // Trusted abv is NOT a plan target. So inject a plan that still lists abv, or start unresolved and
  // catalog fills 45 then web tries 40.

  const sparse = identifiedCandidate({ abv: null });
  const plan = planEnrichment(sparse);
  const result = await executeMetadataEnrichment(sparse, plan, {
    lookupByUpc: async () => ({
      source: "cola_cloud",
      upc: "080686000891",
      product: { upc: "080686000891", name: "Buffalo Trace", brand: "Buffalo Trace", abv: 45, product_type: "DISTILLED SPIRITS" }
    }),
    searchWeb: async () => "snippets",
    extractMetadata: async () => ({ abv: 40 })
  });

  assert.equal(result.candidate.abv.value, 45);
  assert.equal(result.candidate.abv.source, "cola");
  // Web tried 40 after catalog filled — merge should keep cola and may record conflict.
  assert.ok(result.candidate.abv.confidence >= TRUSTED_MIN);
});

test("missing proof derived deterministically from trusted ABV", async () => {
  const candidate = identifiedCandidate({ abv: 45, proof: null }, "cola");
  const plan = planEnrichment(candidate);
  assert.ok(plan.tasks.some((t) => t.field === "proof"));

  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "not_found", upc: "080686000891", product: null }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });

  assert.equal(result.candidate.proof.value, proofFromAbv(45));
  assert.equal(result.candidate.proof.source, "cola");
  assert.ok(result.completed.includes("proof"));
});

test("missing ABV derived deterministically from trusted proof", async () => {
  const candidate = identifiedCandidate({ abv: null, proof: 90 }, "fwgs");
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "not_found", upc: "080686000891", product: null }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });
  assert.equal(result.candidate.abv.value, abvFromProof(90));
  assert.ok(result.completed.includes("abv"));
});

test("missing origin remains null when no source can establish it", async () => {
  const candidate = identifiedCandidate({ origin: null });
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({
      source: "fwgs",
      upc: "080686000891",
      product: { upc: "080686000891", name: "Buffalo Trace", brand: "Buffalo Trace", product_type: "DISTILLED SPIRITS", origin: null }
    }),
    searchWeb: async () => "no useful origin",
    extractMetadata: async () => ({ origin: null })
  });
  assert.equal(result.candidate.origin.value, null);
  assert.ok(result.unresolved.includes("origin"));
});

test("web fallback receives only the requested missing metadata fields", async () => {
  const candidate = identifiedCandidate({ abv: 45, proof: 90, volume_ml: 750, ttb_id: "TTB-1", origin: null }, "cola");
  const plan = planEnrichment(candidate);
  let requested: string[] = [];
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "not_found", upc: "080686000891", product: null }),
    searchWeb: async () => "Kentucky bourbon origin snippets",
    extractMetadata: async (req) => {
      requested = [...req.fields];
      return { origin: "Kentucky" };
    }
  });
  assert.deepEqual(requested, ["origin"]);
  assert.equal(result.candidate.origin.value, "Kentucky");
  assert.equal(result.candidate.origin.source, "web");
  assert.equal(result.candidate.name.value, "Buffalo Trace");
});

test("LLM output cannot overwrite identity fields", async () => {
  const candidate = identifiedCandidate({ origin: null }, "vault");
  const plan = planEnrichment(candidate);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => ({ source: "not_found", upc: "080686000891", product: null }),
    searchWeb: async () => "snippets",
    extractMetadata: async () => {
      // Hostile model returns identity keys — executor only applies metadata targets.
      return {
        origin: "Kentucky",
        // @ts-expect-error intentional hostile payload
        name: "Hijacked Name",
        brand: "Hijacked Brand"
      } as { origin: string };
    }
  });
  assert.equal(result.candidate.name.value, "Buffalo Trace");
  assert.equal(result.candidate.name.source, "vault");
  assert.equal(result.candidate.brand.value, "Buffalo Trace");
  assert.equal(result.candidate.origin.value, "Kentucky");
});

test("conflicting trusted metadata is preserved as a conflict", async () => {
  const candidate = identifiedCandidate({ abv: 45 }, "cola");
  // Manually lower so abv is scheduled, then catalog returns different trusted value... 
  // Better: unresolved abv, catalog returns 45 (cola), and we also merge a second equal-confidence conflict
  // via extract with web (lower) — that won't conflict as trusted.
  // Trusted conflict: start with fwgs abv 40, catalog cola returns 45 — both HIGH, first wins, conflict recorded.
  const withAbv = identifiedCandidate({ abv: 40 }, "fwgs");
  // Force re-enrich by treating as needing enrichment: confidence is HIGH so NOT in plan.
  // Drop confidence to schedule, then apply catalog at HIGH — actually mergeField: existing HIGH 40,
  // incoming HIGH 45 → equal confidence disagree → keep 40 + conflict.
  withAbv.abv = field(40, "fwgs");
  // Put abv in plan by using a plan from a null-abv candidate but execute on withAbv... 
  // Simpler: call execute with null abv candidate plan fields, but mutate after clone... 
  // Use deps: catalog returns 45, and existing candidate has fwgs 40. For 40 to be in targets,
  // confidence must be < ENRICH_BELOW OR unresolved. Set llm 40 (LOW) then catalog 45 overwrites.
  // For conflict at equal confidence: existing cola 45, incoming fwgs 40 via... catalog is second.
  // existing unresolved, catalog 45 fills. Then we need another HIGH source — not in one execute pass easily.
  // Unit-level: use catalog-only path where candidate already has fwgs abv 45 and we inject a custom
  // merge by having lookup return different abv — candidate abv LOW so it's targeted, catalog HIGH fills
  // without conflict. 
  // Force: candidate abv from fwgs (HIGH), targets include abv because we build a synthetic plan.
  const syntheticPlan = planEnrichment(identifiedCandidate({ abv: null }));
  const seeded = identifiedCandidate({ abv: 40 }, "fwgs");
  const result = await executeMetadataEnrichment(seeded, syntheticPlan, {
    lookupByUpc: async () => ({
      source: "cola_cloud",
      upc: "080686000891",
      product: { upc: "080686000891", name: "Buffalo Trace", brand: "Buffalo Trace", abv: 45, product_type: "DISTILLED SPIRITS" }
    }),
    searchWeb: async () => "",
    extractMetadata: async () => ({})
  });
  assert.equal(result.candidate.abv.value, 40);
  assert.ok(result.conflicts.some((c) => c.field === "abv"));
});

test("enrichment failure does not change identified true", async () => {
  const candidate = identifiedCandidate({ origin: null, volume_ml: null });
  const plan = planEnrichment(candidate);
  assert.equal(plan.identified, true);
  const result = await executeMetadataEnrichment(candidate, plan, {
    lookupByUpc: async () => {
      throw new Error("catalog down");
    },
    searchWeb: async () => {
      throw new Error("searx down");
    },
    extractMetadata: async () => {
      throw new Error("ollama down");
    }
  });
  assert.equal(planEnrichment(result.candidate).identified, true);
  assert.ok(result.errors.length > 0);
  assert.equal(result.candidate.name.value, "Buffalo Trace");
});

test("structured extract prompt lists only missing fields and immutable identity", () => {
  const candidate = identifiedCandidate({ origin: null });
  const prompt = buildPrompt({
    candidate,
    fields: ["origin", "ttb_id"],
    webSnippets: "snippet text"
  });
  assert.match(prompt, /immutable/i);
  assert.match(prompt, /origin, ttb_id/);
  assert.doesNotMatch(prompt, /Return ONLY JSON with these keys:.*name/);
  const parsed = parseExtracted('{"origin":"Kentucky","ttb_id":null,"name":"NOPE"}', ["origin", "ttb_id"]);
  assert.equal(parsed.origin, "Kentucky");
  assert.equal(parsed.ttb_id, null);
  assert.equal("name" in parsed, false);
});
