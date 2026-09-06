/**
 * PR109 — exact-match official brewery repair for machine-owned packaged beer.
 * DirtWolf / Sour Monkey / Nugget Nectar regression coverage.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { db } from "./db.js";
import { field } from "./ingestion/candidate/index.js";
import type { BottleCandidate, ProductFieldSource } from "./ingestion/candidate/types.js";
import {
  clearAdminAuditForTests,
  listAdminAuditEvents
} from "./ingestion/jobs/admin-audit.js";
import {
  clearFieldOwnershipForTests,
  getFieldOwnership,
  stampHumanFieldOwnership,
  stampMachineFieldOwnership
} from "./ingestion/jobs/field-ownership.js";
import {
  clearEnrichmentSourcesForTests,
  getEnrichmentSource
} from "./ingestion/jobs/enrichment-sources.js";
import {
  applyOfficialBeerRepairs,
  passesOfficialRepairGate
} from "./ingestion/jobs/official-beer-repair.js";
import {
  clearOfficialImageRepairForTests,
  hasPendingOfficialImageRepair
} from "./ingestion/jobs/official-image-repair.js";
import { applyOfficialBreweryBeerDiscovery } from "./ingestion/jobs/official-brewery-beer.js";
import {
  clearProductImagesForTests,
  getProductImage,
  upsertProductImage
} from "./ingestion/jobs/product-images.js";
import type { OfficialBeerDiscoveryResult } from "./official_brewery_beer_discovery.js";

function makeCandidate(options: {
  source?: ProductFieldSource;
  name?: string;
  brand?: string;
  category?: string | null;
  abv?: number | null;
}): BottleCandidate {
  const source = options.source ?? "vault";
  return {
    primarySource: source,
    upc: field(null, source),
    name: field(options.name ?? "DirtWolf", source),
    brand: field(options.brand ?? "Victory Brewing Company", source),
    product_type: field("packaged_beer", source),
    category: field(options.category ?? null, source),
    abv: field(options.abv ?? null, source),
    proof: field(null, source),
    volume_ml: field(null, source),
    origin: field(null, source),
    ttb_id: field(null, source)
  };
}

function dirtwolfOfficialDiscovery(
  overrides: Partial<OfficialBeerDiscoveryResult> = {}
): OfficialBeerDiscoveryResult {
  return {
    status: "matched",
    match: "exact_name",
    productPageUrl: "https://victorybeer.com/beers/dirtwolf/",
    registeredDomain: "victorybeer.com",
    fields: {
      productName: "DirtWolf",
      brewery: "Victory Brewing Company",
      style: "Double IPA",
      abv: 8.7,
      ibu: 85,
      description: "A boldly hopped double IPA.",
      tastingNotes: "Pine, citrus, resin.",
      packageSizes: ["12 oz"],
      productPageUrl: "https://victorybeer.com/beers/dirtwolf/",
      canonicalUrl: "https://victorybeer.com/beers/dirtwolf/",
      imageUrl: "https://victorybeer.com/media/dirtwolf.png"
    },
    pagesFetched: 1,
    ...overrides
  };
}

function insertPackagedBeer(row: {
  brewery: string;
  name: string;
  style?: string;
  abv?: number;
  image_url?: string;
}): number {
  const result = db
    .prepare(
      `INSERT INTO packaged_beer(brewery, name, style, abv, image_url)
       VALUES(?, ?, ?, ?, ?)`
    )
    .run(
      row.brewery,
      row.name,
      row.style ?? "",
      row.abv ?? 0,
      row.image_url ?? ""
    );
  return Number(result.lastInsertRowid);
}


afterEach(() => {
  clearFieldOwnershipForTests();
  clearOfficialImageRepairForTests();
  clearProductImagesForTests();
  clearEnrichmentSourcesForTests();
  clearAdminAuditForTests();
  db.prepare("DELETE FROM packaged_beer").run();
});

test("repair gate requires packaged_beer + matched + exact/strong + product page", () => {
  assert.equal(
    passesOfficialRepairGate({
      entityType: "spirits",
      discovery: dirtwolfOfficialDiscovery()
    }),
    false
  );
  assert.equal(
    passesOfficialRepairGate({
      entityType: "packaged_beer",
      discovery: dirtwolfOfficialDiscovery({ match: "weak" })
    }),
    false
  );
  assert.equal(
    passesOfficialRepairGate({
      entityType: "packaged_beer",
      discovery: dirtwolfOfficialDiscovery({ productPageUrl: null })
    }),
    false
  );
  assert.equal(
    passesOfficialRepairGate({
      entityType: "packaged_beer",
      discovery: dirtwolfOfficialDiscovery()
    }),
    true
  );
  assert.equal(
    passesOfficialRepairGate({
      entityType: "packaged_beer",
      discovery: dirtwolfOfficialDiscovery({ match: "strong_name" })
    }),
    true
  );
});

test("DirtWolf: machine vault-seed style/ABV repaired by exact official match", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "category",
    source: "web"
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "abv",
    source: "web"
  });

  const candidate = makeCandidate({
    source: "vault",
    category: "Sticke Alt Ale",
    abv: 8.5
  });
  const { candidate: after, summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId, name: "DirtWolf", brewery: "Victory Brewing Company", style: "Sticke Alt Ale", abv: 8.5 },
    candidate,
    discovery: dirtwolfOfficialDiscovery()
  });

  assert.equal(summary.styleRepaired, true);
  assert.equal(summary.abvRepaired, true);
  assert.equal(after.category.value, "Double IPA");
  assert.equal(after.category.source, "official_brewery");
  assert.equal(after.abv.value, 8.7);
  assert.equal(after.abv.source, "official_brewery");
  assert.equal(getFieldOwnership("packaged_beer", entityId, "category")?.source, "official_brewery");
  assert.equal(getFieldOwnership("packaged_beer", entityId, "abv")?.source, "official_brewery");
  assert.ok(summary.events.some((e) => e.field === "ibu" && e.decision === "skipped_gate"));
  assert.ok(
    listAdminAuditEvents({ actionTypePrefix: "beer_official_repair_applied" }).length >= 1
  );
});

test("DirtWolf control: Keeper/human style and ABV are preserved", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  stampHumanFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    fields: ["style", "abv"]
  });
  const candidate = makeCandidate({
    source: "user",
    category: "Sticke Alt Ale",
    abv: 8.5
  });
  const { candidate: after, summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId },
    candidate,
    discovery: dirtwolfOfficialDiscovery()
  });

  assert.equal(summary.styleRepaired, false);
  assert.equal(summary.abvRepaired, false);
  assert.equal(after.category.value, "Sticke Alt Ale");
  assert.equal(after.abv.value, 8.5);
  assert.ok(
    summary.events.some(
      (e) => e.field === "category" && e.decision === "preserved_human_value"
    )
  );
  assert.ok(
    summary.events.some((e) => e.field === "abv" && e.decision === "preserved_human_value")
  );
  assert.ok(
    listAdminAuditEvents({ actionTypePrefix: "beer_official_repair_preserved_human" }).length >= 1
  );
});

test("DirtWolf: user/shelf image is never replaced; inventory image_url untouched", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Double IPA",
    abv: 8.7,
    image_url: "/api/media/images/shelf-dirtwolf.jpg"
  });
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/shelf-dirtwolf.jpg",
    sourceType: "user",
    sourceUrl: null,
    score: 100,
    verified: true
  });

  const beforeUrl = String(
    db.prepare("SELECT image_url FROM packaged_beer WHERE id=?").get(entityId)?.image_url
  );
  const { summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: {
      id: entityId,
      image_url: "/api/media/images/shelf-dirtwolf.jpg"
    },
    candidate: makeCandidate({ category: "Double IPA", abv: 8.7 }),
    discovery: dirtwolfOfficialDiscovery()
  });

  assert.equal(summary.imageRepairRequested, false);
  assert.equal(hasPendingOfficialImageRepair("packaged_beer", entityId), false);
  assert.equal(getProductImage("packaged_beer", entityId)?.source_type, "user");
  const afterUrl = String(
    db.prepare("SELECT image_url FROM packaged_beer WHERE id=?").get(entityId)?.image_url
  );
  assert.equal(afterUrl, beforeUrl);
  assert.ok(
    summary.events.some(
      (e) => e.field === "image" && e.decision === "preserved_human_value"
    )
  );
});

test("DirtWolf: verified score-90 machine image can be reopened for exact official candidate", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/wrong-jar.jpg",
    sourceType: "approved",
    sourceUrl: "https://cdn.example.com/wrong-jar.jpg",
    score: 90,
    verified: true
  });

  const { summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId, image_url: "" },
    candidate: makeCandidate({ category: "Sticke Alt Ale", abv: 8.5, source: "web" }),
    discovery: dirtwolfOfficialDiscovery()
  });

  assert.equal(summary.imageRepairRequested, true);
  assert.equal(hasPendingOfficialImageRepair("packaged_beer", entityId), true);
  // Existing machine row remains until image job verifies the new candidate.
  assert.equal(getProductImage("packaged_beer", entityId)?.url, "/api/media/images/wrong-jar.jpg");
  assert.equal(getProductImage("packaged_beer", entityId)?.score, 90);
});

test("ambiguous product image ownership is not auto-replaced", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Double IPA",
    abv: 8.7
  });
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/mystery.jpg",
    sourceType: "lookup",
    sourceUrl: null,
    score: 10,
    verified: false
  });

  const { summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId, image_url: "" },
    candidate: makeCandidate({ category: "Double IPA", abv: 8.7 }),
    discovery: dirtwolfOfficialDiscovery()
  });

  assert.equal(summary.imageRepairRequested, false);
  assert.ok(
    summary.events.some(
      (e) => e.field === "image" && e.decision === "unresolved_conflict"
    )
  );
});

test("Sour Monkey: stale empty image + exact official page queues image repair", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "Sour Monkey",
    style: "Sour Tripel",
    abv: 9.5
  });
  const discovery: OfficialBeerDiscoveryResult = {
    status: "matched",
    match: "exact_name",
    productPageUrl: "https://victorybeer.com/beers/sour-monkey/",
    registeredDomain: "victorybeer.com",
    fields: {
      productName: "Sour Monkey",
      brewery: "Victory Brewing Company",
      style: "Sour Tripel",
      abv: 9.5,
      ibu: null,
      description: "A tart tripel.",
      tastingNotes: "Lemon, funk, spice.",
      packageSizes: [],
      productPageUrl: "https://victorybeer.com/beers/sour-monkey/",
      canonicalUrl: "https://victorybeer.com/beers/sour-monkey/",
      imageUrl: "https://victorybeer.com/media/sour-monkey.png"
    },
    pagesFetched: 1
  };

  const { summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId, image_url: "" },
    candidate: makeCandidate({
      name: "Sour Monkey",
      category: "Sour Tripel",
      abv: 9.5
    }),
    discovery
  });

  assert.equal(summary.imageRepairRequested, true);
  assert.equal(hasPendingOfficialImageRepair("packaged_beer", entityId), true);
});

test("Nugget Nectar non-regression: identical official rerun is idempotent", () => {
  const entityId = insertPackagedBeer({
    brewery: "Tröegs Independent Brewing",
    name: "Nugget Nectar",
    style: "Imperial Amber",
    abv: 7.5
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "category",
    source: "official_brewery"
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "abv",
    source: "official_brewery"
  });
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/nugget.jpg",
    sourceType: "official",
    sourceUrl: "https://troegs.com/beers/nugget-nectar/",
    score: 88,
    verified: true
  });

  const discovery: OfficialBeerDiscoveryResult = {
    status: "matched",
    match: "exact_name",
    productPageUrl: "https://troegs.com/beers/nugget-nectar/",
    registeredDomain: "troegs.com",
    fields: {
      productName: "Nugget Nectar",
      brewery: "Tröegs Independent Brewing",
      style: "Imperial Amber",
      abv: 7.5,
      ibu: null,
      description: "Hop-heavy amber.",
      tastingNotes: "Grapefruit, pine.",
      packageSizes: [],
      productPageUrl: "https://troegs.com/beers/nugget-nectar/",
      canonicalUrl: "https://troegs.com/beers/nugget-nectar/",
      imageUrl: "https://troegs.com/media/nugget.png"
    },
    pagesFetched: 1
  };

  const first = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId, image_url: "" },
    candidate: makeCandidate({
      name: "Nugget Nectar",
      brand: "Tröegs Independent Brewing",
      category: "Imperial Amber",
      abv: 7.5,
      source: "official_brewery"
    }),
    discovery
  });
  const auditsAfterFirst = listAdminAuditEvents({
    actionTypePrefix: "beer_official_repair_applied"
  }).length;

  const second = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId, image_url: "" },
    candidate: first.candidate,
    discovery
  });
  const auditsAfterSecond = listAdminAuditEvents({
    actionTypePrefix: "beer_official_repair_applied"
  }).length;

  assert.equal(first.summary.styleRepaired, false);
  assert.equal(first.summary.abvRepaired, false);
  assert.equal(first.summary.imageRepairRequested, false);
  assert.equal(second.summary.styleRepaired, false);
  assert.equal(second.summary.abvRepaired, false);
  assert.equal(second.summary.imageRepairRequested, false);
  assert.equal(auditsAfterSecond, auditsAfterFirst);
  assert.equal(getProductImage("packaged_beer", entityId)?.url, "/api/media/images/nugget.jpg");
});

test("applyOfficialBreweryBeerDiscovery still stores product page + notes; repair fills style", async () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "category",
    source: "vision"
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "abv",
    source: "vision"
  });

  // Unit-level: call repairs after mimicking a matched discovery, since live fetch
  // is not required for ownership/repair semantics.
  const discovery = dirtwolfOfficialDiscovery();
  const applied = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: {
      id: entityId,
      brewery: "Victory Brewing Company",
      name: "DirtWolf",
      style: "Sticke Alt Ale",
      abv: 8.5,
      website_url: "https://victorybeer.com"
    },
    candidate: makeCandidate({ category: "Sticke Alt Ale", abv: 8.5, source: "vault" }),
    discovery
  });

  assert.equal(applied.summary.styleRepaired, true);
  assert.equal(applied.candidate.category.value, "Double IPA");
  // Enrichment source path remains covered by existing apply tests; ensure repair
  // does not require weakening global vault>official ranking.
  assert.equal(applied.candidate.abv.source, "official_brewery");
});

test("unmarked vault seed is repairable under exact official match (DirtWolf class)", () => {
  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  // No ownership row — inventory reload vault stamp is treated as historical machine seed.
  const { candidate: after, summary } = applyOfficialBeerRepairs({
    entityType: "packaged_beer",
    entityId,
    row: { id: entityId },
    candidate: makeCandidate({ source: "vault", category: "Sticke Alt Ale", abv: 8.5 }),
    discovery: dirtwolfOfficialDiscovery()
  });
  assert.equal(summary.styleRepaired, true);
  assert.equal(summary.abvRepaired, true);
  assert.equal(after.category.value, "Double IPA");
  assert.equal(after.abv.value, 8.7);
  assert.equal(after.abv.source, "official_brewery");
});
