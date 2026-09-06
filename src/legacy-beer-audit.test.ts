/**
 * PR112 — Keeper-only legacy packaged-beer audit.
 * Preview/queue orchestration only; canonical metadata remains owned by PR109/PR111.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import {
  clearAdminAuditForTests,
  getLatestAdminAuditEvent
} from "./ingestion/jobs/admin-audit.js";
import {
  clearEnrichmentSourcesForTests,
  getEnrichmentSource,
  upsertEnrichmentSource
} from "./ingestion/jobs/enrichment-sources.js";
import {
  clearFieldOwnershipForTests,
  getFieldOwnership,
  stampHumanFieldOwnership,
  stampMachineFieldOwnership
} from "./ingestion/jobs/field-ownership.js";
import {
  auditPackagedBeer,
  previewLegacyBeerAudit,
  queueLegacyBeerAudit,
  recoverOfficialBreweryDomainFromEvidence
} from "./ingestion/jobs/legacy-beer-audit.js";
import { runMetadataJob } from "./ingestion/jobs/metadata-job.js";
import {
  clearProductContentForTests,
  getProductContent,
  upsertProductContent
} from "./ingestion/jobs/product-content.js";
import {
  clearProductImagesForTests,
  upsertProductImage
} from "./ingestion/jobs/product-images.js";
import {
  clearEnrichmentJobsForTests,
  enqueueMetadataJob,
  hasActiveEnrichmentJob,
  listJobsForEntity,
  markJobCompleted
} from "./ingestion/jobs/store.js";
import { clearOfficialBeerDiscoveryCache } from "./official_brewery_beer_discovery.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken } = await import("./server.js");

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/official-brewery-beer"
);

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
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

function cleanup(): void {
  clearFieldOwnershipForTests();
  clearEnrichmentJobsForTests();
  clearEnrichmentSourcesForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  clearAdminAuditForTests();
  clearOfficialBeerDiscoveryCache();
  db.prepare("DELETE FROM packaged_beer").run();
}

afterEach(() => {
  delete process.env.OPEN_BREWERY_DB_ENABLED;
  cleanup();
});

function seedHistoricalMetadataJob(
  entityId: number,
  result: Record<string, unknown>
): void {
  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });
  markJobCompleted(job.id, result);
}

function dirtWolfHtmlFetch() {
  const html = fixture("victory-dirtwolf.html");
  const indexHtml = fixture("victory-beer-index.html");
  return async (url: string) => {
    const u = url.toLowerCase();
    if (u.includes("victorybeer.com") && u.includes("dirtwolf")) {
      return {
        finalUrl: "https://victorybeer.com/beers/dirtwolf/",
        html,
        contentType: "text/html"
      };
    }
    if (u.includes("victorybeer.com")) {
      return { finalUrl: url, html: indexHtml, contentType: "text/html" };
    }
    return {
      finalUrl: url,
      html: "<html><body>not found</body></html>",
      contentType: "text/html"
    };
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    lookupByUpc: async () => ({ source: "none" as const, upc: "", product: null }),
    searchWebHits: async () => [],
    extractMetadata: async () => ({}),
    fetchPageHtml: async () => null as string | null,
    ...overrides
  };
}

test("DirtWolf legacy fixture: recovers victorybeer.com and queues metadata without rewriting style/ABV", () => {
  cleanup();

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
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://victorybeer.com/beers/dirtwolf/"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });

  const audit = auditPackagedBeer(entityId);
  assert.equal(audit.candidate, true);
  assert.ok(audit.reasons.includes("historical_machine_metadata"));
  assert.ok(audit.reasons.includes("no_official_brewery_domain"));
  assert.ok(
    audit.reasons.includes("known_official_product_page_without_domain")
    || audit.reasons.includes("official_source_available_but_not_reprocessed")
  );
  assert.equal(audit.recoveredOfficialDomain, "victorybeer.com");
  assert.equal(
    recoverOfficialBreweryDomainFromEvidence({ entityId }),
    "victorybeer.com"
  );

  const preview = previewLegacyBeerAudit();
  assert.ok(preview.candidates >= 1);
  assert.equal(
    getEnrichmentSource("packaged_beer", entityId, "official_brewery_domain"),
    null
  );

  const queued = queueLegacyBeerAudit({ limit: 50 });
  assert.equal(queued.queued, 1);
  assert.equal(queued.domainsBackfilled, 1);
  assert.equal(
    getEnrichmentSource("packaged_beer", entityId, "official_brewery_domain")?.sourceUrl,
    "https://victorybeer.com"
  );
  assert.equal(hasActiveEnrichmentJob("packaged_beer", entityId, "metadata"), true);

  const row = db
    .prepare("SELECT style, abv FROM packaged_beer WHERE id=?")
    .get(entityId) as { style: string; abv: number };
  assert.equal(row.style, "Sticke Alt Ale");
  assert.equal(row.abv, 8.5);

  assert.ok(getLatestAdminAuditEvent("legacy_beer_audit_queue"));
});

test("DirtWolf end-to-end: queued metadata + domain enables PR111/PR109 repair for machine-owned fields", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5,
    image_url: "/api/media/images/wrong-machine.jpg"
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
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/wrong-machine.jpg",
    sourceType: "approved",
    sourceUrl: "https://cdn.example.com/wrong-machine.jpg",
    score: 90,
    verified: true
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://victorybeer.com/beers/dirtwolf/"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });

  const queued = queueLegacyBeerAudit();
  assert.equal(queued.queued, 1);

  const pending = listJobsForEntity("packaged_beer", entityId).find(
    (job) => job.job_type === "metadata" && job.status === "pending"
  );
  assert.ok(pending);

  const result = await runMetadataJob(
    pending!,
    baseDeps({
      officialBeerDiscoveryDeps: {
        fetchHtml: dirtWolfHtmlFetch()
      }
    })
  );

  assert.equal(result.skipped, false);
  const row = db
    .prepare("SELECT style, abv FROM packaged_beer WHERE id=?")
    .get(entityId) as { style: string; abv: number };
  assert.equal(row.style, "Double IPA");
  assert.equal(row.abv, 8.7);
  assert.equal(
    getFieldOwnership("packaged_beer", entityId, "category")?.source,
    "official_brewery"
  );
  assert.equal(
    getFieldOwnership("packaged_beer", entityId, "abv")?.source,
    "official_brewery"
  );
  const notes = getProductContent("packaged_beer", entityId);
  assert.ok(String(notes?.official_tasting_notes ?? "").trim().length > 0);
});

test("Namaste healthy modern control: optional gaps alone do not select", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Dogfish Head Craft Brewery",
    name: "Namaste",
    style: "White Ale",
    abv: 4.8
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_brewery_domain",
    sourceUrl: "https://www.dogfish.com"
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://www.dogfish.com/brewery/beer/namaste"
  });
  upsertProductContent({
    entityType: "packaged_beer",
    entityId,
    officialNotes: "A witbier with orange peel and lemongrass.",
    officialSourceUrl: "https://www.dogfish.com/brewery/beer/namaste",
    officialSourceType: "official"
  });
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/namaste.jpg",
    sourceType: "official",
    sourceUrl: "https://www.dogfish.com/brewery/beer/namaste",
    score: 95,
    verified: true
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: ["category", "abv"],
    unresolved: [],
    officialBreweryDiscovery: {
      attempted: true,
      status: "matched",
      productPageStored: true
    }
  });

  const audit = auditPackagedBeer(entityId);
  assert.equal(audit.candidate, false);
  assert.deepEqual(audit.reasons, []);
});

test("historical no_result packaged beer is a queueable candidate", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Yards Brewing Co.",
    name: "Brawler",
    style: "English Mild",
    abv: 4.1
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "category",
    source: "web"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });

  const audit = auditPackagedBeer(entityId);
  assert.equal(audit.candidate, true);
  assert.ok(
    audit.reasons.includes("metadata_no_result")
    || audit.reasons.includes("historical_machine_metadata")
    || audit.reasons.includes("metadata_predates_official_pipeline")
  );

  const queued = queueLegacyBeerAudit();
  assert.equal(queued.queued, 1);
});

test("historical complete job before official pipeline remains queueable", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "abv",
    source: "vision"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["abv"],
    updated: ["abv"],
    unresolved: []
  });

  const audit = auditPackagedBeer(entityId);
  assert.equal(audit.candidate, true);
  assert.ok(audit.reasons.includes("metadata_predates_official_pipeline"));
});

test("modern complete official match is not a candidate", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Troegs Independent Brewing",
    name: "Nugget Nectar",
    style: "Imperial Amber Ale",
    abv: 7.5
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_brewery_domain",
    sourceUrl: "https://www.troegs.com"
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://www.troegs.com/beer/nugget-nectar/"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: ["category", "abv"],
    unresolved: [],
    officialBreweryDiscovery: {
      attempted: true,
      status: "matched",
      productPageStored: true
    }
  });

  const audit = auditPackagedBeer(entityId);
  assert.equal(audit.candidate, false);
});

test("human-owned values may still be queued but audit never retags them as machine", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  stampHumanFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    fields: ["category", "abv"]
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://victorybeer.com/beers/dirtwolf/"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });

  const audit = auditPackagedBeer(entityId);
  assert.equal(audit.candidate, true);
  assert.equal(getFieldOwnership("packaged_beer", entityId, "category")?.ownership, "human");
  assert.equal(getFieldOwnership("packaged_beer", entityId, "abv")?.ownership, "human");

  queueLegacyBeerAudit();
  assert.equal(getFieldOwnership("packaged_beer", entityId, "category")?.ownership, "human");
  assert.equal(getFieldOwnership("packaged_beer", entityId, "abv")?.ownership, "human");
});

test("active metadata job is deduped as already queued", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Yards Brewing Co.",
    name: "Brawler",
    style: "English Mild",
    abv: 4.1
  });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId,
    field: "category",
    source: "web"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category"],
    updated: [],
    unresolved: ["category"]
  });
  enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  const queued = queueLegacyBeerAudit();
  assert.equal(queued.queued, 0);
  assert.equal(queued.alreadyQueued, 1);
});

test("queue is bounded and reports remaining candidates", () => {
  cleanup();

  for (let i = 0; i < 3; i += 1) {
    const entityId = insertPackagedBeer({
      brewery: "Yards Brewing Co.",
      name: `Legacy Mild ${i}`,
      style: "English Mild",
      abv: 4.1
    });
    stampMachineFieldOwnership({
      entityType: "packaged_beer",
      entityId,
      field: "category",
      source: "web"
    });
    seedHistoricalMetadataJob(entityId, {
      requested: ["category"],
      updated: [],
      unresolved: ["category"]
    });
  }

  const queued = queueLegacyBeerAudit({ limit: 2 });
  assert.equal(queued.candidates, 3);
  assert.equal(queued.queued, 2);
  assert.equal(queued.remaining, 1);
});

test("retailer/blog URLs are not recovered as official brewery domains", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://www.totalwine.com/beer/dirtwolf"
  });

  assert.equal(recoverOfficialBreweryDomainFromEvidence({ entityId }), null);
});

test("unrelated website_url classifying as unknown is not recovered or backfilled", () => {
  cleanup();

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
  seedHistoricalMetadataJob(entityId, {
    requested: ["category", "abv"],
    updated: [],
    unresolved: ["category", "abv"]
  });

  const row = {
    id: entityId,
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    website_url: "https://random-example-site.com"
  };

  assert.equal(
    recoverOfficialBreweryDomainFromEvidence({ entityId, row }),
    null
  );

  const audit = auditPackagedBeer(entityId, row);
  assert.equal(audit.candidate, true);
  assert.equal(audit.recoveredOfficialDomain, null);

  const queued = queueLegacyBeerAudit();
  assert.equal(queued.queued, 1);
  assert.equal(queued.domainsBackfilled, 0);
  assert.equal(
    getEnrichmentSource("packaged_beer", entityId, "official_brewery_domain"),
    null
  );
});

test("Victory official product page still recovers victorybeer.com", () => {
  cleanup();

  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://victorybeer.com/beers/dirtwolf/"
  });

  assert.equal(
    recoverOfficialBreweryDomainFromEvidence({ entityId }),
    "victorybeer.com"
  );
});

test("active jobs do not consume the queue limit so later candidates are reached", () => {
  cleanup();

  const ids: number[] = [];
  for (let i = 0; i < 55; i += 1) {
    const entityId = insertPackagedBeer({
      brewery: "Yards Brewing Co.",
      name: `Legacy Mild ${i}`,
      style: "English Mild",
      abv: 4.1
    });
    stampMachineFieldOwnership({
      entityType: "packaged_beer",
      entityId,
      field: "category",
      source: "web"
    });
    seedHistoricalMetadataJob(entityId, {
      requested: ["category"],
      updated: [],
      unresolved: ["category"]
    });
    ids.push(entityId);
  }

  // First 50 candidates already have an active metadata job.
  for (const entityId of ids.slice(0, 50)) {
    enqueueMetadataJob({
      entityType: "packaged_beer",
      entityId,
      upc: ""
    });
  }

  const queued = queueLegacyBeerAudit({ limit: 50 });
  assert.equal(queued.candidates, 55);
  assert.equal(queued.alreadyQueued, 50);
  assert.equal(queued.queued, 5);
  assert.equal(queued.remaining, 0);

  for (const entityId of ids.slice(50)) {
    assert.equal(
      hasActiveEnrichmentJob("packaged_beer", entityId, "metadata"),
      true,
      `candidate ${entityId} should be newly queued`
    );
  }
});

test("guest cannot preview or queue legacy beer audit", async () => {
  cleanup();
  const preview = await app.inject({
    method: "GET",
    url: "/api/admin/enrichment/legacy-beer-audit"
  });
  assert.equal(preview.statusCode, 401);

  const queue = await app.inject({
    method: "POST",
    url: "/api/admin/enrichment/legacy-beer-audit",
    payload: {}
  });
  assert.equal(queue.statusCode, 401);
});

test("admin can preview and queue legacy beer audit via API", async () => {
  cleanup();

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
  upsertEnrichmentSource({
    entityType: "packaged_beer",
    entityId,
    sourceType: "official_product_page",
    sourceUrl: "https://victorybeer.com/beers/dirtwolf/"
  });
  seedHistoricalMetadataJob(entityId, {
    requested: ["category"],
    updated: [],
    unresolved: ["category"]
  });

  const token = createTestAdminToken();

  const preview = await app.inject({
    method: "GET",
    url: "/api/admin/enrichment/legacy-beer-audit",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(preview.statusCode, 200);
  const previewBody = preview.json() as { candidates: number };
  assert.ok(previewBody.candidates >= 1);
  assert.equal(
    getEnrichmentSource("packaged_beer", entityId, "official_brewery_domain"),
    null
  );

  const queue = await app.inject({
    method: "POST",
    url: "/api/admin/enrichment/legacy-beer-audit",
    headers: { authorization: `Bearer ${token}` },
    payload: {}
  });
  assert.equal(queue.statusCode, 200);
  const queueBody = queue.json() as { queued: number; domainsBackfilled: number };
  assert.equal(queueBody.queued, 1);
  assert.equal(queueBody.domainsBackfilled, 1);
  assert.equal(
    getEnrichmentSource("packaged_beer", entityId, "official_brewery_domain")?.sourceUrl,
    "https://victorybeer.com"
  );
});
