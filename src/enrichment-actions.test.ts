/**
 * PR123 — Keeper enrichment actions on current architecture.
 * Auth, rerun/retry, ownership verify, conflict resolve, entity allowlists,
 * Guest boundary, and delete cleanup regressions.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { createAdminToken } = await import("./auth.js");
const { sessionSecret } = await import("./server.js");
const { db } = await import("./db.js");
const { saveBarcodeCacheEntry } = await import("./barcode_cache.js");
const { saveToCache } = await import("./ingestion/catalogs/cola-cache-store.js");
const {
  clearAdminAuditForTests,
  recordAdminAuditEvent
} = await import("./ingestion/jobs/admin-audit.js");
const {
  clearFieldOwnershipForTests,
  getFieldOwnership,
  stampMachineFieldOwnership,
  classifyStoredFieldForOfficialRepair
} = await import("./ingestion/jobs/field-ownership.js");
const {
  clearEnrichmentJobsForTests,
  enqueueMetadataJob,
  enqueueTastingNotesJob,
  enqueueImageJob,
  markJobCompleted,
  markJobFailedOrRetry,
  listJobsForEntity
} = await import("./ingestion/jobs/store.js");
const { clearProductContentForTests } = await import("./ingestion/jobs/product-content.js");
const { clearProductImagesForTests } = await import("./ingestion/jobs/product-images.js");
const { deleteInventoryItemSafely } = await import("./inventory-delete.js");
const {
  rerunItemEnrichmentJob,
  verifyEnrichmentField,
  resolveEnrichmentConflict
} = await import("./ingestion/jobs/enrichment-actions.js");
const { buildBottleEnrichmentView } = await import("./ingestion/jobs/enrichment-view.js");

const UPC = "080686999217";
const NAME = "PR123 Keeper Actions";

function insertBeer(overrides: Record<string, unknown> = {}) {
  const row = {
    brewery: "Victory Brewing Company",
    name: NAME,
    style: "Double IPA",
    abv: 8.7,
    upc: UPC,
    image_url: "",
    ...overrides
  };
  const result = db
    .prepare(
      `INSERT INTO packaged_beer (brewery, name, style, abv, upc, image_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(row.brewery, row.name, row.style, row.abv, row.upc, row.image_url);
  return Number(result.lastInsertRowid);
}

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const row = {
    name: `${NAME} Spirit`,
    brand: "Auth Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc: UPC,
    ...overrides
  };
  const result = db
    .prepare(
      `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc);
  return Number(result.lastInsertRowid);
}

function cleanup() {
  clearEnrichmentJobsForTests();
  clearProductContentForTests();
  clearProductImagesForTests();
  clearFieldOwnershipForTests();
  clearAdminAuditForTests();
  db.prepare("DELETE FROM packaged_beer WHERE upc=? OR name LIKE ?").run(UPC, `${NAME}%`);
  db.prepare("DELETE FROM spirits WHERE upc=? OR name LIKE ?").run(UPC, `${NAME}%`);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(UPC);
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(UPC);
  db.prepare("DELETE FROM beer_cache WHERE upc=?").run(UPC);
  db.prepare("DELETE FROM product_field_ownership WHERE entity_id IN (SELECT id FROM packaged_beer WHERE upc=?)").run(UPC);
}

afterEach(() => cleanup());

function authHeader(token = createTestAdminToken()) {
  return { authorization: `Bearer ${token}` };
}

test("Guest cannot invoke rerun, retry, resolve-conflict, or verify", async () => {
  cleanup();
  const id = insertBeer();
  for (const path of [
    `/api/inventory/packaged_beer/${id}/enrichment/rerun`,
    `/api/inventory/packaged_beer/${id}/enrichment/verify-field`,
    `/api/inventory/packaged_beer/${id}/enrichment/resolve-conflict`
  ]) {
    const res = await app.inject({
      method: "POST",
      url: path,
      payload: path.includes("rerun")
        ? { jobType: "metadata" }
        : path.includes("verify")
          ? { field: "abv" }
          : { field: "abv", choice: "keep" }
    });
    assert.equal(res.statusCode, 401, path);
    assert.equal((res.json() as { error: string }).error, "Admin session required");
  }
});

test("invalid/expired Keeper credentials are rejected for enrichment actions", async () => {
  cleanup();
  const id = insertBeer();
  const expired = createAdminToken(sessionSecret, Date.now() - 60_000);
  const res = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/rerun`,
    headers: authHeader(expired),
    payload: { jobType: "metadata" }
  });
  assert.equal(res.statusCode, 401);
});

test("failed metadata job can be retried and completed metadata can explicitly rerun", async () => {
  cleanup();
  const id = insertBeer();
  const { job } = enqueueMetadataJob({ entityType: "packaged_beer", entityId: id, upc: UPC });
  // Force fail past max attempts
  db.prepare("UPDATE enrichment_jobs SET attempts = max_attempts, status = 'failed', last_error = ? WHERE id = ?").run(
    "boom",
    job.id
  );

  const retry = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/rerun`,
    headers: authHeader(),
    payload: { jobType: "metadata" }
  });
  assert.equal(retry.statusCode, 200);
  const retryBody = retry.json() as { queued: string[]; skipped: unknown[] };
  assert.deepEqual(retryBody.queued, ["metadata"]);

  // Complete the new job, then explicit rerun
  const latest = listJobsForEntity("packaged_beer", id).find((j) => j.job_type === "metadata");
  assert.ok(latest);
  markJobCompleted(latest!.id, { updated: ["abv"] });

  const rerun = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/rerun`,
    headers: authHeader(),
    payload: { jobType: "metadata" }
  });
  assert.equal(rerun.statusCode, 200);
  assert.deepEqual((rerun.json() as { queued: string[] }).queued, ["metadata"]);
});

test("tasting-notes and image jobs can rerun; active job is deduplicated", async () => {
  cleanup();
  const id = insertBeer();
  const tasting = enqueueTastingNotesJob({ entityType: "packaged_beer", entityId: id, upc: UPC });
  markJobCompleted(tasting.job.id);
  const image = enqueueImageJob({ entityType: "packaged_beer", entityId: id, upc: UPC });
  markJobCompleted(image.job.id);

  const tastingRerun = rerunItemEnrichmentJob({
    entityType: "packaged_beer",
    entityId: id,
    jobType: "tasting_notes"
  });
  assert.ok(!("error" in tastingRerun));
  assert.deepEqual(tastingRerun.queued, ["tasting_notes"]);

  const imageRerun = rerunItemEnrichmentJob({
    entityType: "packaged_beer",
    entityId: id,
    jobType: "image"
  });
  assert.ok(!("error" in imageRerun));
  assert.deepEqual(imageRerun.queued, ["image"]);

  const dedupe = rerunItemEnrichmentJob({
    entityType: "packaged_beer",
    entityId: id,
    jobType: "tasting_notes"
  });
  assert.ok(!("error" in dedupe));
  assert.deepEqual(dedupe.queued, []);
  assert.ok(dedupe.skipped.some((s) => s.reason === "already_queued"));
});

test("unsupported job type and missing entity are rejected", async () => {
  cleanup();
  const id = insertBeer();
  const badType = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/rerun`,
    headers: authHeader(),
    payload: { jobType: "bulk_review" }
  });
  assert.equal(badType.statusCode, 400);

  const missing = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/999999/enrichment/rerun`,
    headers: authHeader(),
    payload: { jobType: "metadata" }
  });
  assert.equal(missing.statusCode, 404);

  const badTable = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/1/enrichment/rerun`,
    headers: authHeader(),
    payload: { jobType: "metadata" }
  });
  assert.equal(badTable.statusCode, 404);
});

test("packaged beer allowlists: ABV/style verify allowed; proof/volume/origin/ttb rejected", async () => {
  cleanup();
  const id = insertBeer();
  const token = createTestAdminToken();

  const abv = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/verify-field`,
    headers: authHeader(token),
    payload: { field: "abv" }
  });
  assert.equal(abv.statusCode, 200);
  assert.equal(getFieldOwnership("packaged_beer", id, "abv")?.ownership, "human");

  const style = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/verify-field`,
    headers: authHeader(token),
    payload: { field: "style" }
  });
  assert.equal(style.statusCode, 200);
  assert.equal(getFieldOwnership("packaged_beer", id, "category")?.ownership, "human");

  for (const field of ["proof", "volume_ml", "origin", "ttb_id"]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/inventory/packaged_beer/${id}/enrichment/verify-field`,
      headers: authHeader(token),
      payload: { field }
    });
    assert.equal(res.statusCode, 400, field);
  }
});

test("Keeper-confirmed packaged-beer ABV/style stay human-owned against machine repair", async () => {
  cleanup();
  const id = insertBeer({ abv: 8.1, style: "IPA" });
  const verified = verifyEnrichmentField({
    entityType: "packaged_beer",
    entityId: id,
    field: "abv"
  });
  assert.ok(!("error" in verified));
  verifyEnrichmentField({
    entityType: "packaged_beer",
    entityId: id,
    field: "category"
  });

  const abvClass = classifyStoredFieldForOfficialRepair({
    entityType: "packaged_beer",
    entityId: id,
    field: "abv",
    candidateSource: "web"
  });
  assert.equal(abvClass.repairable, false);
  assert.equal(abvClass.ownership, "human");

  const styleClass = classifyStoredFieldForOfficialRepair({
    entityType: "packaged_beer",
    entityId: id,
    field: "category",
    candidateSource: "web"
  });
  assert.equal(styleClass.repairable, false);

  // Machine-owned remains repairable
  clearFieldOwnershipForTests();
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId: id,
    field: "abv",
    source: "web"
  });
  const machine = classifyStoredFieldForOfficialRepair({
    entityType: "packaged_beer",
    entityId: id,
    field: "abv",
    candidateSource: "web"
  });
  assert.equal(machine.repairable, true);
});

test("conflict resolution rejects missing conflict, free-form values, and unsupported fields", async () => {
  cleanup();
  const id = insertBeer();
  const token = createTestAdminToken();

  const none = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/resolve-conflict`,
    headers: authHeader(token),
    payload: { field: "abv", choice: "keep" }
  });
  assert.equal(none.statusCode, 400);

  const injected = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/resolve-conflict`,
    headers: authHeader(token),
    payload: { field: "abv", choice: "accept", value: 99 }
  });
  assert.equal(injected.statusCode, 400);
  assert.match((injected.json() as { error: string }).error, /Replacement values/);

  const proof = await app.inject({
    method: "POST",
    url: `/api/inventory/packaged_beer/${id}/enrichment/resolve-conflict`,
    headers: authHeader(token),
    payload: { field: "proof", choice: "accept" }
  });
  assert.equal(proof.statusCode, 400);
});

test("ownership conflict keep preserves value; accept applies trusted competing value", async () => {
  cleanup();
  const id = insertBeer({ abv: 8.1, style: "IPA" });
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId: id,
    field: "abv",
    source: "web"
  });
  recordAdminAuditEvent("beer_official_repair_evaluated", {
    entityId: id,
    entityType: "packaged_beer",
    field: "abv",
    decision: "unresolved_conflict",
    previousValue: 8.1,
    previousSource: "web",
    incomingValue: 8.7,
    incomingSource: "official_brewery"
  });

  const view = buildBottleEnrichmentView({
    entityType: "packaged_beer",
    entityId: id,
    includeDiagnostics: true
  });
  assert.ok(view?.enrichment.conflicts.some((c) => c.field === "abv" && c.resolvable));

  const keep = resolveEnrichmentConflict({
    entityType: "packaged_beer",
    entityId: id,
    field: "abv",
    choice: "keep"
  });
  assert.ok(!("error" in keep));
  const rowAfterKeep = db.prepare("SELECT abv FROM packaged_beer WHERE id=?").get(id) as { abv: number };
  assert.equal(rowAfterKeep.abv, 8.1);
  assert.equal(getFieldOwnership("packaged_beer", id, "abv")?.ownership, "human");

  // New unresolved style conflict for accept path
  clearFieldOwnershipForTests();
  stampMachineFieldOwnership({
    entityType: "packaged_beer",
    entityId: id,
    field: "category",
    source: "web"
  });
  recordAdminAuditEvent("beer_official_repair_evaluated", {
    entityId: id,
    entityType: "packaged_beer",
    field: "category",
    decision: "unresolved_conflict",
    previousValue: "IPA",
    previousSource: "web",
    incomingValue: "Double IPA",
    incomingSource: "official_brewery"
  });

  const accept = resolveEnrichmentConflict({
    entityType: "packaged_beer",
    entityId: id,
    field: "style",
    choice: "accept"
  });
  assert.ok(!("error" in accept));
  const rowAfterAccept = db.prepare("SELECT style FROM packaged_beer WHERE id=?").get(id) as {
    style: string;
  };
  assert.equal(rowAfterAccept.style, "Double IPA");
  assert.equal(getFieldOwnership("packaged_beer", id, "category")?.ownership, "human");
});

test("identity conflict keep aligns caches; accept updates inventory via server value", async () => {
  cleanup();
  const id = insertSpirit({ name: "Vault Spirit", brand: "Vault Brand" });
  saveBarcodeCacheEntry({
    upc: UPC,
    name: "Cache Spirit",
    brand: "Cache Brand",
    category: "Bourbon",
    subcategory: "",
    abv: 45,
    proof: 90,
    volume_ml: 750,
    description: "",
    image_url: "",
    source: "barcode_cache"
  });
  saveToCache(
    {
      upc: UPC,
      name: "Cache Spirit",
      brand: "Cache Brand",
      category: "Bourbon",
      abv: 45,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: null,
      origin: null,
      approval_date: null
    },
    null,
    null,
    "cola_cache"
  );

  const before = buildBottleEnrichmentView({
    entityType: "spirits",
    entityId: id,
    includeDiagnostics: true
  });
  const nameConflict = before?.enrichment.conflicts.find((c) => c.field === "name" && c.resolvable);
  assert.ok(nameConflict, "expected resolvable name conflict");

  const keep = resolveEnrichmentConflict({
    entityType: "spirits",
    entityId: id,
    field: "name",
    choice: "keep"
  });
  assert.ok(!("error" in keep));
  const spirit = db.prepare("SELECT name FROM spirits WHERE id=?").get(id) as { name: string };
  assert.equal(spirit.name, "Vault Spirit");
  const barcode = db.prepare("SELECT name FROM barcode_cache WHERE upc=?").get(UPC) as { name: string };
  assert.equal(barcode.name, "Vault Spirit");

  // Re-seed brand conflict for accept (both caches agree on competing brand)
  saveBarcodeCacheEntry({
    upc: UPC,
    name: "Vault Spirit",
    brand: "Competing Brand",
    category: "Bourbon",
    subcategory: "",
    abv: 45,
    proof: 90,
    volume_ml: 750,
    description: "",
    image_url: "",
    source: "barcode_cache"
  });
  saveToCache(
    {
      upc: UPC,
      name: "Vault Spirit",
      brand: "Competing Brand",
      category: "Bourbon",
      abv: 45,
      image_url: null,
      fill_level_percent: 100,
      bottle_count: 1,
      notes: null,
      volume_ml: 750,
      product_type: "spirit",
      ttb_id: null,
      origin: null,
      approval_date: null
    },
    null,
    null,
    "cola_cache"
  );
  const accept = resolveEnrichmentConflict({
    entityType: "spirits",
    entityId: id,
    field: "brand",
    choice: "accept"
  });
  assert.ok(!("error" in accept));
  const spirit2 = db.prepare("SELECT brand FROM spirits WHERE id=?").get(id) as { brand: string };
  assert.equal(spirit2.brand, "Competing Brand");
});

test("Guest enrichment response stays redacted after action endpoints exist", async () => {
  cleanup();
  const id = insertBeer();
  const guest = await app.inject({
    method: "GET",
    url: `/api/inventory/packaged_beer/${id}/enrichment`
  });
  assert.equal(guest.statusCode, 200);
  const body = guest.json() as Record<string, unknown>;
  assert.equal(body.identity, undefined);
  assert.equal(body.enrichment, undefined);
  assert.equal(body.inventory, undefined);
  assert.equal(body.metadata, undefined);
  assert.equal(body.conflicts, undefined);
  assert.ok(!guest.body.includes(UPC));
  assert.ok(!guest.body.includes("resolvable"));
  assert.ok(!guest.body.includes("product_field_ownership"));
});

test("deleting an item cleans ownership and leaves no orphan review state", async () => {
  cleanup();
  const id = insertBeer();
  verifyEnrichmentField({ entityType: "packaged_beer", entityId: id, field: "abv" });
  assert.ok(getFieldOwnership("packaged_beer", id, "abv"));

  const deleted = deleteInventoryItemSafely("packaged_beer", id);
  assert.equal(deleted.status, "deleted");
  assert.equal(getFieldOwnership("packaged_beer", id, "abv"), null);
  const orphans = db
    .prepare(
      `SELECT COUNT(*) AS n FROM product_field_ownership
       WHERE entity_type='packaged_beer' AND entity_id=?`
    )
    .get(id) as { n: number };
  assert.equal(orphans.n, 0);
});

test("markJobFailed helper still supports retry path used by actions", () => {
  cleanup();
  const id = insertBeer();
  const { job } = enqueueMetadataJob({ entityType: "packaged_beer", entityId: id, upc: UPC });
  // Claim-like: set running then fail once (below max) → pending again
  db.prepare("UPDATE enrichment_jobs SET status='running', attempts=1 WHERE id=?").run(job.id);
  markJobFailedOrRetry(job.id, "temporary");
  const row = db.prepare("SELECT status FROM enrichment_jobs WHERE id=?").get(job.id) as {
    status: string;
  };
  assert.equal(row.status, "pending");
});
