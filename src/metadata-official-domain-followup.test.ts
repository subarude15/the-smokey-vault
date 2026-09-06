/**
 * PR111 — packaged-beer metadata sequencing:
 * when generic enrichment newly establishes an official brewery domain,
 * run exactly one follow-up official brewery discovery attempt in the same job.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import {
  clearFieldOwnershipForTests,
  getFieldOwnership,
  stampMachineFieldOwnership
} from "./ingestion/jobs/field-ownership.js";
import {
  clearEnrichmentSourcesForTests,
  getEnrichmentSource,
  upsertEnrichmentSource
} from "./ingestion/jobs/enrichment-sources.js";
import { candidateFromInventoryRow } from "./ingestion/jobs/inventory.js";
import { runMetadataJob } from "./ingestion/jobs/metadata-job.js";
import {
  metadataLastRunLabel,
  metadataOutcomeFromState
} from "./ingestion/jobs/metadata-outcome.js";
import {
  clearOfficialImageRepairForTests,
  hasPendingOfficialImageRepair
} from "./ingestion/jobs/official-image-repair.js";
import {
  clearProductContentForTests,
  getProductContent
} from "./ingestion/jobs/product-content.js";
import {
  clearProductImagesForTests,
  upsertProductImage
} from "./ingestion/jobs/product-images.js";
import {
  clearEnrichmentJobsForTests,
  enqueueMetadataJob
} from "./ingestion/jobs/store.js";
import { clearOfficialBeerDiscoveryCache } from "./official_brewery_beer_discovery.js";

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
  clearOfficialImageRepairForTests();
  clearEnrichmentSourcesForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  clearOfficialBeerDiscoveryCache();
  db.prepare("DELETE FROM packaged_beer").run();
}

afterEach(() => {
  delete process.env.OPEN_BREWERY_DB_ENABLED;
  cleanup();
});

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

function victoryOfficialSearchHits() {
  return [
    {
      title: "DirtWolf | Victory Brewing Company",
      url: "https://victorybeer.com/beers/dirtwolf/",
      content: "Official Victory Brewing beer page for DirtWolf."
    },
    {
      title: "DirtWolf review on a beer blog",
      url: "https://beerblog.example/dirtwolf",
      content: "Fan notes"
    }
  ];
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    lookupByUpc: async () => ({ source: "none" as const, upc: "", product: null }),
    searchWebHits: async () => victoryOfficialSearchHits(),
    extractMetadata: async () => ({}),
    fetchPageHtml: async () => null as string | null,
    ...overrides
  };
}

test("DirtWolf: generic-established victorybeer.com triggers one follow-up official repair", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

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
  // Machine-owned product image (not a bare local path, which is treated as user/shelf).
  upsertProductImage({
    entityType: "packaged_beer",
    entityId,
    url: "/api/media/images/wrong-machine.jpg",
    sourceType: "approved",
    sourceUrl: "https://cdn.example.com/wrong-machine.jpg",
    score: 90,
    verified: true
  });

  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  let officialFetchCalls = 0;
  const fetchHtml = dirtWolfHtmlFetch();
  const result = await runMetadataJob(
    job,
    baseDeps({
      officialBeerDiscoveryDeps: {
        fetchHtml: async (url: string) => {
          officialFetchCalls += 1;
          return fetchHtml(url);
        }
      }
    })
  );

  assert.equal(result.skipped, false);
  assert.equal(result.officialBreweryDiscovery?.followUpAttempted, true);
  assert.equal(result.officialBreweryDiscovery?.followUpStatus, "matched");
  assert.equal(
    result.officialBreweryDiscovery?.officialDomainEstablishedAfterGeneric,
    "victorybeer.com"
  );

  const followUpAttempts = (result.execution?.diagnostics.stages ?? []).filter(
    (s) => s.stage === "official_brewery_followup_attempt"
  );
  assert.equal(followUpAttempts.length, 1);
  assert.ok(officialFetchCalls >= 1, "follow-up official discovery should fetch pages");

  const row = db
    .prepare("SELECT style, abv FROM packaged_beer WHERE id=?")
    .get(entityId) as { style: string; abv: number };
  assert.equal(row.style, "Double IPA");
  assert.equal(row.abv, 8.7);
  assert.equal(getFieldOwnership("packaged_beer", entityId, "category")?.source, "official_brewery");
  assert.equal(getFieldOwnership("packaged_beer", entityId, "abv")?.source, "official_brewery");

  const notes = getProductContent("packaged_beer", entityId);
  assert.ok(String(notes?.official_tasting_notes ?? "").trim().length > 0);
  assert.equal(hasPendingOfficialImageRepair("packaged_beer", entityId), true);

  const storedDomain = getEnrichmentSource(
    "packaged_beer",
    entityId,
    "official_brewery_domain"
  );
  assert.ok(String(storedDomain?.sourceUrl ?? "").includes("victorybeer.com"));

  assert.ok((result.resultPayload.updated?.length ?? 0) > 0);
  const fullRow = db
    .prepare("SELECT * FROM packaged_beer WHERE id=?")
    .get(entityId) as Record<string, unknown>;
  const candidate = candidateFromInventoryRow("packaged_beer", fullRow);
  const label = metadataLastRunLabel({
    bottleOutcome: metadataOutcomeFromState({
      candidate,
      entityType: "packaged_beer",
      entityId
    }),
    stored: result.resultPayload
  });
  assert.notEqual(label, "No new data found");
  assert.notEqual(label, "No result");
});

test("DirtWolf ambiguous ownership: follow-up matches but does not weaken PR109 gates", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

  const entityId = insertPackagedBeer({
    brewery: "Victory Brewing Company",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });

  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  const result = await runMetadataJob(
    job,
    baseDeps({
      officialBeerDiscoveryDeps: {
        fetchHtml: dirtWolfHtmlFetch()
      }
    })
  );

  assert.equal(result.officialBreweryDiscovery?.followUpAttempted, true);
  assert.equal(result.officialBreweryDiscovery?.followUpStatus, "matched");

  const row = db
    .prepare("SELECT style, abv FROM packaged_beer WHERE id=?")
    .get(entityId) as { style: string; abv: number };
  assert.equal(row.style, "Sticke Alt Ale");
  assert.equal(row.abv, 8.5);

  const notes = getProductContent("packaged_beer", entityId);
  assert.ok(String(notes?.official_tasting_notes ?? "").trim().length > 0);
});

test("already-known official domain: initial match skips unnecessary follow-up", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

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
    sourceType: "official_brewery_domain",
    sourceUrl: "https://victorybeer.com"
  });

  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  let officialFetches = 0;
  const fetchHtml = dirtWolfHtmlFetch();
  const result = await runMetadataJob(
    job,
    baseDeps({
      officialBeerDiscoveryDeps: {
        fetchHtml: async (url: string) => {
          officialFetches += 1;
          return fetchHtml(url);
        }
      }
    })
  );

  assert.equal(result.officialBreweryDiscovery?.status, "matched");
  assert.equal(result.officialBreweryDiscovery?.followUpAttempted, false);
  const skipped = (result.execution?.diagnostics.stages ?? []).find(
    (s) => s.stage === "official_brewery_followup_attempt"
  );
  if (skipped) assert.equal(skipped.status, "skipped");
  assert.ok(officialFetches >= 1);
});

test("generic retailer/blog-only results do not trigger follow-up official discovery", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

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

  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  let officialFetches = 0;
  const result = await runMetadataJob(
    job,
    baseDeps({
      searchWebHits: async () => [
        {
          title: "Buy DirtWolf at Total Wine",
          url: "https://www.totalwine.com/beer/dirtwolf",
          content: "Retail listing"
        },
        {
          title: "DirtWolf blog review",
          url: "https://somereview.blog/dirtwolf",
          content: "UGC notes"
        }
      ],
      officialBeerDiscoveryDeps: {
        fetchHtml: async () => {
          officialFetches += 1;
          return { finalUrl: "https://example.com/", html: "<html></html>", contentType: "text/html" };
        }
      }
    })
  );

  assert.equal(result.officialBreweryDiscovery?.followUpAttempted, false);
  assert.equal(result.officialBreweryDiscovery?.officialDomainEstablishedAfterGeneric, null);
  assert.equal(officialFetches, 0, "no official domain means no official page fetches");
});

test("follow-up miss: only one attempt, generic result remains final", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

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

  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  let followUpFetches = 0;
  const result = await runMetadataJob(
    job,
    baseDeps({
      officialBeerDiscoveryDeps: {
        fetchHtml: async () => {
          followUpFetches += 1;
          return {
            finalUrl: "https://victorybeer.com/beers/dirtwolf/",
            html: "<html><body>no beer here</body></html>",
            contentType: "text/html"
          };
        }
      }
    })
  );

  assert.equal(result.officialBreweryDiscovery?.followUpAttempted, true);
  assert.notEqual(result.officialBreweryDiscovery?.followUpStatus, "matched");
  const followUps = (result.execution?.diagnostics.stages ?? []).filter(
    (s) => s.stage === "official_brewery_followup_attempt"
  );
  assert.equal(followUps.length, 1);
  assert.ok(followUpFetches >= 1);

  const row = db
    .prepare("SELECT style, abv FROM packaged_beer WHERE id=?")
    .get(entityId) as { style: string; abv: number };
  assert.equal(row.style, "Sticke Alt Ale");
  assert.equal(row.abv, 8.5);
});

test("needsReview / not identified: metadata job skips before follow-up official repair", async () => {
  cleanup();
  process.env.OPEN_BREWERY_DB_ENABLED = "false";

  const entityId = insertPackagedBeer({
    brewery: "",
    name: "DirtWolf",
    style: "Sticke Alt Ale",
    abv: 8.5
  });
  const { job } = enqueueMetadataJob({
    entityType: "packaged_beer",
    entityId,
    upc: ""
  });

  const result = await runMetadataJob(
    job,
    baseDeps({
      officialBeerDiscoveryDeps: {
        fetchHtml: async () => {
          throw new Error("should not run official discovery");
        }
      }
    })
  );

  assert.equal(result.skipped, true);
  assert.ok(result.reason === "not_identified" || result.reason === "needs_review");
  assert.equal(result.officialBreweryDiscovery, undefined);
});
