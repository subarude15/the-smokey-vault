import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { field, mergeField, type FieldConflict } from "../candidate/index.js";
import {
  classifySourceUrl,
  executeTastingNotesEnrichment,
  formatHouseProfile,
  parseOfficialNotesExtract
} from "../enrichment/index.js";
import {
  claimNextPendingJob,
  clearEnrichmentJobsForTests,
  clearProductContentForTests,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  getEnrichmentJob,
  getProductContent,
  markJobCompleted,
  maybeEnqueueMetadataEnrichment,
  maybeEnqueueTastingNotesEnrichment,
  readPersonalNotes,
  runEnrichmentWorkerOnce,
  runTastingNotesJob,
  upsertProductContent
} from "./index.js";

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: "Buffalo Trace",
    brand: "Buffalo Trace",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc: "080686000891",
    notes: "",
    tasting_notes: "",
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    row.brand,
    row.category,
    row.abv,
    row.volume_ml,
    row.upc,
    row.notes,
    row.tasting_notes
  );
  const id = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM spirits WHERE id=?").get(id) as Record<string, unknown>;
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  db.prepare("DELETE FROM spirits WHERE upc LIKE '080686%' OR name LIKE 'TasteTest%'").run();
}

test("identified bottle can enqueue tasting-note job", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest Enqueue", upc: "080686100001" });
  const result = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(result.enqueued, true);
  if (result.enqueued) {
    assert.equal(result.job.job_type, "tasting_notes");
    assert.equal(result.created, true);
  }
  cleanup();
});

test("unidentified bottle does not automatically enqueue tasting-note job", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest NoId", upc: "080686100002" });
  db.prepare("UPDATE spirits SET brand=? WHERE id=?").run("", spirit.id);
  const row = db.prepare("SELECT * FROM spirits WHERE id=?").get(spirit.id) as Record<string, unknown>;
  const result = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(row.id),
    row
  });
  assert.equal(result.enqueued, false);
  if (!result.enqueued) assert.equal(result.reason, "not_identified");
  cleanup();
});

test("needsReview prevents automatic tasting-note enrichment", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest Review", upc: "080686100003" });
  const conflict = mergeField(
    field("Buffalo Trace", "vault"),
    field("Buffalo Trace Distillery", "cola"),
    "name"
  ).conflict as FieldConflict;
  const result = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit,
    planOptions: { conflicts: [conflict] }
  });
  assert.equal(result.enqueued, false);
  if (!result.enqueued) assert.equal(result.reason, "needs_review");
  cleanup();
});

test("duplicate active tasting-note jobs are deduped", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest Dup", upc: "080686100004" });
  const first = enqueueTastingNotesJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686100004"
  });
  const second = enqueueTastingNotesJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686100004"
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  cleanup();
});

test("official producer notes are stored with source URL", async () => {
  cleanup();
  const upc = "080686100005";
  const spirit = insertSpirit({ name: "TasteTest Official", upc, brand: "Buffalo Trace" });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runTastingNotesJob(claimed, {
    searchWebHits: async () => [
      {
        title: "Buffalo Trace Bourbon",
        content: "Tasting notes: caramel, vanilla, and spice.",
        url: "https://www.buffalotrace.com/products/buffalo-trace"
      }
    ],
    extractOfficial: async () => ({
      official_notes: "Caramel, vanilla, and spice.",
      source_url: "https://www.buffalotrace.com/products/buffalo-trace",
      confidence: "official"
    }),
    generateHouseProfile: async () => ({
      aroma: "Vanilla",
      palate: "Caramel",
      finish: "Warm spice",
      flavor_tags: ["vanilla", "caramel"]
    })
  });
  assert.equal(result.skipped, false);
  assert.equal(result.officialSaved, true);
  const content = getProductContent("spirits", Number(spirit.id));
  assert.equal(content?.official_tasting_notes, "Caramel, vanilla, and spice.");
  assert.equal(content?.official_source_url, "https://www.buffalotrace.com/products/buffalo-trace");
  assert.equal(content?.official_source_type, "official");
  markJobCompleted(claimed.id);
  cleanup();
});

test("retailer/blog text is not treated as official producer notes", async () => {
  cleanup();
  assert.equal(classifySourceUrl("https://www.totalwine.com/spirits/buffalo-trace", { brand: "Buffalo Trace" }), "retailer");
  assert.equal(classifySourceUrl("https://www.reddit.com/r/bourbon/comments/x", { brand: "Buffalo Trace" }), "ugc");
  assert.equal(classifySourceUrl("https://bourbonblog.medium.com/review", { brand: "Buffalo Trace" }), "ugc");

  const upc = "080686100006";
  const spirit = insertSpirit({ name: "TasteTest Retail", upc, brand: "Buffalo Trace" });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  await runTastingNotesJob(claimed, {
    searchWebHits: async () => [
      {
        title: "Buy Buffalo Trace",
        content: "Sweet caramel tasting notes from our buyers.",
        url: "https://www.totalwine.com/spirits/buffalo-trace"
      },
      {
        title: "Reddit review",
        content: "I taste cherries and oak.",
        url: "https://www.reddit.com/r/bourbon/comments/abc"
      }
    ],
    extractOfficial: async () => {
      throw new Error("extract should not run without authoritative hits");
    },
    generateHouseProfile: async () => ({
      aroma: null,
      palate: null,
      finish: null,
      flavor_tags: []
    })
  });
  const content = getProductContent("spirits", Number(spirit.id));
  assert.equal(content?.official_tasting_notes ?? null, null);
  assert.equal(content?.official_source_url ?? null, null);
  markJobCompleted(claimed.id);
  cleanup();
});

test("no authoritative source results in completed job with null official notes", async () => {
  cleanup();
  const upc = "080686100007";
  const spirit = insertSpirit({ name: "TasteTest None", upc });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runTastingNotesJob(claimed, {
    searchWebHits: async () => [],
    extractOfficial: async () => ({ official_notes: null, source_url: null, confidence: "none" }),
    generateHouseProfile: async () => ({
      aroma: "Light grain",
      palate: "Soft oak",
      finish: "Short",
      flavor_tags: ["grain", "oak"]
    })
  });
  assert.equal(result.skipped, false);
  markJobCompleted(claimed.id);
  assert.equal(getEnrichmentJob(claimed.id)?.status, "completed");
  assert.equal(getProductContent("spirits", Number(spirit.id))?.official_tasting_notes ?? null, null);
  cleanup();
});

test("AI house profile is stored separately from official notes", async () => {
  cleanup();
  const upc = "080686100008";
  const spirit = insertSpirit({ name: "TasteTest House", upc, brand: "Eagle Rare" });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  await runTastingNotesJob(claimed, {
    searchWebHits: async () => [
      {
        title: "Eagle Rare",
        content: "Official: toffee and orange peel.",
        url: "https://www.eaglerare.com/bourbon"
      }
    ],
    extractOfficial: async () => ({
      official_notes: "Toffee and orange peel.",
      source_url: "https://www.eaglerare.com/bourbon",
      confidence: "official"
    }),
    generateHouseProfile: async () => ({
      aroma: "Orange oil",
      palate: "Toffee",
      finish: "Long oak",
      flavor_tags: ["orange", "toffee", "oak"]
    })
  });
  const content = getProductContent("spirits", Number(spirit.id))!;
  assert.ok(content.official_tasting_notes?.includes("Toffee"));
  assert.ok(content.house_tasting_profile?.includes("AI house profile"));
  assert.ok(content.house_tasting_profile?.includes("Orange oil"));
  assert.notEqual(content.official_tasting_notes, content.house_tasting_profile);
  markJobCompleted(claimed.id);
  cleanup();
});

test("existing personal/user notes are not overwritten", async () => {
  cleanup();
  const upc = "080686100009";
  const spirit = insertSpirit({
    name: "TasteTest Personal",
    upc,
    tasting_notes: "My personal peat bomb notes",
    notes: "Cellar: top shelf left"
  });
  const beforePersonal = readPersonalNotes(spirit);
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  const claimed = claimNextPendingJob()!;
  const result = await runTastingNotesJob(claimed, {
    searchWebHits: async () => [
      {
        title: "Buffalo Trace",
        content: "Vanilla.",
        url: "https://www.buffalotrace.com/x"
      }
    ],
    extractOfficial: async () => ({
      official_notes: "Vanilla.",
      source_url: "https://www.buffalotrace.com/x",
      confidence: "official"
    }),
    generateHouseProfile: async () => ({
      aroma: "Vanilla",
      palate: "Oak",
      finish: "Short",
      flavor_tags: ["vanilla"]
    })
  });
  assert.equal(result.personalNotes, beforePersonal);
  const row = db.prepare("SELECT tasting_notes, notes FROM spirits WHERE id=?").get(spirit.id) as {
    tasting_notes: string;
    notes: string;
  };
  assert.equal(row.tasting_notes, "My personal peat bomb notes");
  assert.equal(row.notes, "Cellar: top shelf left");
  assert.equal(getProductContent("spirits", Number(spirit.id))?.official_tasting_notes, "Vanilla.");
  markJobCompleted(claimed.id);
  cleanup();
});

test("tasting-note failure does not affect bottle identity or inventory", async () => {
  cleanup();
  const upc = "080686100010";
  const spirit = insertSpirit({ name: "TasteTest Fail", brand: "KeepMe", upc, abv: 45 });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(spirit.id), upc });
  await runEnrichmentWorkerOnce({
    tastingNotesDeps: {
      searchWebHits: async () => {
        throw new Error("searxng timeout");
      },
      generateHouseProfile: async () => {
        throw new Error("ollama timeout");
      }
    }
  });
  const row = db.prepare("SELECT name, brand, abv FROM spirits WHERE id=?").get(spirit.id) as Record<string, unknown>;
  assert.equal(row.name, "TasteTest Fail");
  assert.equal(row.brand, "KeepMe");
  assert.equal(row.abv, 45);
  const job = db.prepare("SELECT status FROM enrichment_jobs WHERE entity_id=? AND job_type='tasting_notes'")
    .get(spirit.id) as { status: string };
  assert.equal(job.status, "pending"); // retried
  cleanup();
});

test("scan response does not wait for tasting-note execution", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest Fast", upc: "080686100011" });
  const started = Date.now();
  const result = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const elapsed = Date.now() - started;
  assert.equal(result.enqueued, true);
  assert.ok(elapsed < 100, `enqueue took ${elapsed}ms`);
  assert.equal(getProductContent("spirits", Number(spirit.id)), null);
  cleanup();
});

test("worker continues after tasting-note job failure", async () => {
  cleanup();
  const a = insertSpirit({ name: "TasteTest A", upc: "080686100012" });
  const b = insertSpirit({ name: "TasteTest B", upc: "080686100013" });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(a.id), upc: "080686100012" });
  enqueueTastingNotesJob({ entityType: "spirits", entityId: Number(b.id), upc: "080686100013" });

  const deps = {
    searchWebHits: async (query: string) => {
      if (query.includes("080686100012")) throw new Error("boom");
      return [
        {
          title: "B",
          content: "notes",
          url: "https://www.buffalotrace.com/b"
        }
      ];
    },
    extractOfficial: async () => ({
      official_notes: "Clean grain.",
      source_url: "https://www.buffalotrace.com/b",
      confidence: "official" as const
    }),
    generateHouseProfile: async () => {
      // First job also fails house generation so the job retries instead of
      // completing with a house-only result.
      throw new Error("house boom");
    }
  };

  await runEnrichmentWorkerOnce({ tastingNotesDeps: deps });
  // Second job: allow house profile so B can complete after search succeeds.
  await runEnrichmentWorkerOnce({
    tastingNotesDeps: {
      ...deps,
      generateHouseProfile: async () => ({
        aroma: "Grain",
        palate: "Soft",
        finish: "Short",
        flavor_tags: ["grain"]
      })
    }
  });

  const statuses = db.prepare(`
    SELECT upc, status FROM enrichment_jobs
    WHERE upc IN ('080686100012','080686100013')
    ORDER BY upc
  `).all() as Array<{ upc: string; status: string }>;
  assert.equal(statuses[0]?.status, "pending");
  assert.equal(statuses[1]?.status, "completed");
  cleanup();
});

test("existing metadata queue behavior remains unchanged", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest Meta", upc: "080686100014", abv: 0 });
  const meta = maybeEnqueueMetadataEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  const taste = maybeEnqueueTastingNotesEnrichment({
    entityType: "spirits",
    entityId: Number(spirit.id),
    row: spirit
  });
  assert.equal(meta.enqueued, true);
  assert.equal(taste.enqueued, true);
  if (meta.enqueued && taste.enqueued) {
    assert.equal(meta.job.job_type, "metadata");
    assert.equal(taste.job.job_type, "tasting_notes");
    assert.notEqual(meta.job.id, taste.job.id);
  }
  // Metadata + tasting_notes can both be active for the same entity.
  const againMeta = enqueueMetadataJob({
    entityType: "spirits",
    entityId: Number(spirit.id),
    upc: "080686100014"
  });
  assert.equal(againMeta.created, false);
  cleanup();
});

test("classifySourceUrl marks brand domains official", () => {
  assert.equal(
    classifySourceUrl("https://www.buffalotrace.com/bourbon", { brand: "Buffalo Trace" }),
    "official"
  );
  assert.equal(
    classifySourceUrl("https://importer-agency.com/portfolio", { brand: "Obscure Brand" }),
    "importer"
  );
});

test("parseOfficialNotesExtract refuses incomplete payloads", () => {
  assert.deepEqual(
    parseOfficialNotesExtract({ official_notes: "x", source_url: null, confidence: "official" }),
    { official_notes: null, source_url: null, confidence: "none" }
  );
  assert.ok(formatHouseProfile({
    aroma: "A",
    palate: null,
    finish: null,
    flavor_tags: ["a"]
  })?.startsWith("AI house profile"));
});

test("executeTastingNotesEnrichment ignores retailer-only hits for official notes", async () => {
  const candidate = {
    primarySource: "vault" as const,
    upc: field("1", "vault"),
    name: field("Buffalo Trace", "vault"),
    brand: field("Buffalo Trace", "vault"),
    product_type: field("spirit", "vault"),
    category: field("Bourbon", "vault"),
    abv: field(45, "vault"),
    proof: field(90, "vault"),
    volume_ml: field(750, "vault"),
    origin: field(null, "vault"),
    ttb_id: field(null, "vault")
  };
  const result = await executeTastingNotesEnrichment(candidate, {
    searchWebHits: async () => [
      {
        title: "Retail",
        content: "Caramel notes",
        url: "https://www.totalwine.com/x"
      }
    ],
    extractOfficial: async () => {
      throw new Error("should not extract");
    },
    generateHouseProfile: async () => ({
      aroma: null,
      palate: null,
      finish: null,
      flavor_tags: []
    })
  }, { wantHouseProfile: false });
  assert.equal(result.officialNotes, null);
  assert.equal(result.officialSourceUrl, null);
});

test("upsert does not overwrite official with unsourced text", () => {
  cleanup();
  const spirit = insertSpirit({ name: "TasteTest Upsert", upc: "080686100015" });
  upsertProductContent({
    entityType: "spirits",
    entityId: Number(spirit.id),
    officialNotes: "Producer caramel",
    officialSourceUrl: "https://www.buffalotrace.com/x",
    officialSourceType: "official"
  });
  upsertProductContent({
    entityType: "spirits",
    entityId: Number(spirit.id),
    officialNotes: "Random blog copy",
    officialSourceUrl: null,
    officialSourceType: null
  });
  assert.equal(
    getProductContent("spirits", Number(spirit.id))?.official_tasting_notes,
    "Producer caramel"
  );
  cleanup();
});
