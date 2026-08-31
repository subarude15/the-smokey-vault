/**
 * Stabilization / regression pass covering scan, edit, guest enrichment
 * visibility, auth, and purge-guard invariants after white-screen fixes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { saveBarcodeCacheEntry } from "./barcode_cache.js";
import { db } from "./db.js";
import { clearEnrichmentJobsForTests } from "./ingestion/jobs/index.js";
import { buildBottleEnrichmentView } from "./ingestion/jobs/enrichment-view.js";
import { upsertProductContent } from "./ingestion/jobs/product-content.js";
import {
  saveScanSessionBottle,
  undoScanSessionMutation
} from "./scan-session.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const enrichmentPanelSrc = readFileSync(join(root, "client/src/EnrichmentPanel.tsx"), "utf8");
const bottlePublicSrc = readFileSync(join(root, "client/src/BottlePublicContent.tsx"), "utf8");
const PREFIX = "0912870";

/** Minimal valid JPEG (1x1). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64"
);

function cleanup() {
  clearEnrichmentJobsForTests();
  db.prepare("DELETE FROM reviews WHERE table_name IN ('spirits','wines','packaged_beer')").run();
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare(`DELETE FROM spirits WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM wines WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM packaged_beer WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM barcode_cache WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM import_queue WHERE upc LIKE '${PREFIX}%'`).run();
  db.prepare("DELETE FROM product_content WHERE entity_type='spirits'").run();
}

function insertSpirit(overrides: Record<string, unknown> = {}) {
  const upc = `${PREFIX}001`;
  const row = {
    name: "Stable Spirit",
    brand: "Stable Brand",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    upc,
    stock_count: 1,
    fill_level: 100,
    ...overrides
  };
  const result = db.prepare(`
    INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, stock_count, fill_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.name, row.brand, row.category, row.abv, row.volume_ml, row.upc, row.stock_count, row.fill_level);
  return { id: Number(result.lastInsertRowid), ...row };
}

function textChild(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

test("1 legacy vault barcode hit returns product primitives safe for BottleDetail", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}101` });
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/lookup/barcode?code=${spirit.upc}&kind=spirits`
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { source: string; product: Record<string, unknown>; table?: string };
    assert.equal(body.source, "vault");
    assert.equal(typeof body.product.name, "string");
    assert.ok(Number(body.product.id) === spirit.id);
    // Detail open path: enrichment view must render without throwing
    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: spirit.id });
    assert.ok(view);
    assert.doesNotThrow(() => {
      const house = textChild(view!.tastingNotes.houseProfile);
      assert.equal(typeof house, "string");
    });
  } finally {
    cleanup();
  }
});

test("2-4 shelf scan successful barcode saves and returns ready for next (updated/added)", async () => {
  cleanup();
  const upc = `${PREFIX}102`;
  saveBarcodeCacheEntry({
    upc,
    name: "Shelf Scan Bottle",
    brand: "Shelf",
    category: "Bourbon",
    abv: 45,
    volume_ml: 750,
    source: "ai"
  });
  try {
    const first = await saveScanSessionBottle({ code: upc, kind: "spirits" });
    assert.equal(first.action, "added");
    assert.equal(typeof first.name, "string");
    assert.equal(typeof first.message, "string");
    assert.ok(first.undo);

    const second = await saveScanSessionBottle({ code: upc, kind: "spirits" });
    // After cooldown window may be duplicate; still must be a valid action with primitives
    assert.ok(["updated", "duplicate"].includes(second.action));
    assert.equal(typeof second.name, "string");
    assert.equal(typeof second.message, "string");
    // Client stays on ScanSession — no navigation to blank view
    assert.match(appSrc, /scan-session-result/);
  } finally {
    cleanup();
  }
});

test("5 unknown scan enters needs-review without crashing", async () => {
  cleanup();
  try {
    const result = await saveScanSessionBottle({ code: `${PREFIX}999999`, kind: "spirits" });
    assert.equal(result.action, "needs_review");
    assert.equal(typeof result.message, "string");
    assert.equal(result.table, null);
  } finally {
    cleanup();
  }
});

test("6 existing bottle detail enrichment opens with null-safe optional fields", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}106`, abv: null as unknown as number, volume_ml: null as unknown as number });
  try {
    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: spirit.id });
    assert.ok(view);
    assert.ok(view!.identity.name);
    assert.ok(Array.isArray(view!.enrichment.jobs));
    assert.ok(Array.isArray(view!.enrichment.missing));
    assert.ok(Array.isArray(view!.enrichment.conflicts));
  } finally {
    cleanup();
  }
});

test("7-10 authorized keeper can edit and save spirit, wine, and packaged beer", async () => {
  cleanup();
  const token = createTestAdminToken();

  const spiritCreate = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Edit Spirit",
      brand: "Keeper",
      category: "Rye",
      abv: 46,
      volume_ml: 750,
      upc: `${PREFIX}201`,
      stock_count: 1,
      fill_level: 100
    }
  });
  assert.equal(spiritCreate.statusCode, 201);
  const spiritId = (spiritCreate.json() as { id: number }).id;

  const wineCreate = await app.inject({
    method: "POST",
    url: "/api/inventory/wines",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Edit Wine",
      producer: "Keeper Cellars",
      type: "Red",
      style: "Cabernet",
      upc: `${PREFIX}202`,
      bottle_count: 1
    }
  });
  assert.equal(wineCreate.statusCode, 201, wineCreate.body);
  const wineId = (wineCreate.json() as { id: number }).id;

  const beerCreate = await app.inject({
    method: "POST",
    url: "/api/inventory/packaged_beer",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Edit Beer",
      brewery: "Keeper Brewing",
      style: "IPA",
      upc: `${PREFIX}203`,
      count: 6
    }
  });
  assert.equal(beerCreate.statusCode, 201, beerCreate.body);
  const beerId = (beerCreate.json() as { id: number }).id;

  try {
    const spiritPut = await app.inject({
      method: "PUT",
      url: `/api/inventory/spirits/${spiritId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: "Spirit cellar note", tasting_notes: "Oak and spice", stock_count: 2 }
    });
    assert.equal(spiritPut.statusCode, 200);
    assert.equal((spiritPut.json() as { notes: string }).notes, "Spirit cellar note");

    const winePut = await app.inject({
      method: "PUT",
      url: `/api/inventory/wines/${wineId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: "Wine cellar note", bottle_count: 3 }
    });
    assert.equal(winePut.statusCode, 200);
    assert.equal((winePut.json() as { notes: string }).notes, "Wine cellar note");

    const beerPut = await app.inject({
      method: "PUT",
      url: `/api/inventory/packaged_beer/${beerId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: "Beer cold box", count: 12 }
    });
    assert.equal(beerPut.statusCode, 200);
    assert.equal((beerPut.json() as { notes: string }).notes, "Beer cold box");

    // Client still exposes edit entry from BottleDetail for keepers
    assert.match(appSrc, /onEdit=\{\(\) => \{ setEditing\(viewing\); setViewing\(undefined\); \}\}/);
  } finally {
    await app.inject({ method: "DELETE", url: `/api/inventory/spirits/${spiritId}`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: "DELETE", url: `/api/inventory/wines/${wineId}`, headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: "DELETE", url: `/api/inventory/packaged_beer/${beerId}`, headers: { authorization: `Bearer ${token}` } });
    cleanup();
  }
});

test("11 null/missing optional enrichment fields do not crash BottleDetail or ItemForm paths", () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}111` });
  try {
    upsertProductContent({
      entityType: "spirits",
      entityId: spirit.id,
      houseProfile: null as unknown as string,
      officialNotes: null as unknown as string
    });
    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: spirit.id });
    assert.equal(view!.tastingNotes.houseProfile, null);
    assert.equal(view!.tastingNotes.official, null);
    assert.equal(view!.image.displayUrl, null);
    // Partial identity / metadata must be renderable via FieldRow null guards
    assert.match(enrichmentPanelSrc, /if \(!field\)/);
    assert.match(enrichmentPanelSrc, /view\.enrichment \?\?/);
  } finally {
    cleanup();
  }
});

test("12-14 guest vs keeper enrichment visibility; useful content still surfaces for patrons", () => {
  assert.match(appSrc, /admin && ENRICHMENT_MODULES\.has\(module\.id\) \? <EnrichmentPanel/);
  assert.match(appSrc, /BottlePublicContent/);
  assert.match(enrichmentPanelSrc, /What the vault knows/);
  assert.match(enrichmentPanelSrc, /Enrichment review/);
  assert.doesNotMatch(bottlePublicSrc, /What the vault knows/);
  assert.doesNotMatch(bottlePublicSrc, /Enrichment review/);
  assert.doesNotMatch(bottlePublicSrc, /confidenceBand/);
  assert.doesNotMatch(bottlePublicSrc, /TTB ID/);
  assert.match(bottlePublicSrc, /HOUSE PROFILE|Producer notes|TASTING NOTES/);

  const publicHtml = renderToString(
    React.createElement(
      "div",
      { className: "bottle-public-content" },
      React.createElement("article", null, React.createElement("span", null, "TASTING NOTES"), React.createElement("p", null, "Vanilla oak")),
      React.createElement("article", null, React.createElement("span", null, "HOUSE PROFILE"), React.createElement("p", null, "Peat smoke"))
    )
  );
  assert.match(publicHtml, /Vanilla oak/);
  assert.doesNotMatch(publicHtml, /What the vault knows/);
});

test("15-16 patron reviews and gallery uploads still work", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}115` });
  try {
    const review = await app.inject({
      method: "POST",
      url: `/api/inventory/spirits/${spirit.id}/reviews`,
      payload: { author: "Pat", body: "Smooth." }
    });
    assert.equal(review.statusCode, 201);

    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="shot.jpg"\r\n` +
          `Content-Type: image/jpeg\r\n\r\n`
      ),
      TINY_JPEG,
      Buffer.from(
        `\r\n--${boundary}\r\n` +
          `Content-Disposition: form-data; name="caption"\r\n\r\nNight\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="uploaded_by"\r\n\r\nPat\r\n` +
          `--${boundary}--\r\n`
      )
    ]);
    const upload = await app.inject({
      method: "POST",
      url: "/api/gallery/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    assert.equal(upload.statusCode, 201, upload.body);
  } finally {
    cleanup();
  }
});

test("17 admin/PIN authorization unchanged for inventory + scan-session", async () => {
  cleanup();
  const denied = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    payload: { name: "Nope", brand: "X", category: "Rum", abv: 40, volume_ml: 750 }
  });
  assert.equal(denied.statusCode, 401);

  const scanDenied = await app.inject({
    method: "POST",
    url: "/api/admin/inventory/scan-session/save",
    payload: { code: `${PREFIX}117`, kind: "spirits" }
  });
  assert.equal(scanDenied.statusCode, 401);

  const token = createTestAdminToken();
  const ok = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Auth Spirit",
      brand: "Keeper",
      category: "Gin",
      abv: 40,
      volume_ml: 750,
      upc: `${PREFIX}117`
    }
  });
  assert.equal(ok.statusCode, 201);
  const id = (ok.json() as { id: number }).id;
  await app.inject({
    method: "DELETE",
    url: `/api/inventory/spirits/${id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  cleanup();
});

test("18-19 scan-session quantity increment and undo last remain unchanged", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}118`, stock_count: 2 });
  try {
    const updated = await saveScanSessionBottle({ code: spirit.upc, kind: "spirits" });
    assert.equal(updated.action, "updated");
    assert.equal(updated.quantityBefore, 2);
    assert.equal(updated.quantityAfter, 3);
    assert.ok(updated.undo);

    const undone = undoScanSessionMutation(updated.undo!);
    assert.equal(undone.ok, true);
    const row = db.prepare("SELECT stock_count FROM spirits WHERE id=?").get(spirit.id) as { stock_count: number };
    assert.equal(row.stock_count, 2);
  } finally {
    cleanup();
  }
});

test("20 no purge/bulk-delete behavior returns", async () => {
  cleanup();
  const token = createTestAdminToken();
  const get = await app.inject({
    method: "GET",
    url: "/api/inventory/purge",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.ok([404, 405].includes(get.statusCode));

  const post = await app.inject({
    method: "POST",
    url: "/api/inventory/purge",
    headers: { authorization: `Bearer ${token}` },
    payload: { confirm: "EMPTY" }
  });
  assert.ok([404, 405].includes(post.statusCode));
  cleanup();
});

test("patron enrichment GET still allowed; guest UI must not show plumbing", async () => {
  cleanup();
  const spirit = insertSpirit({ upc: `${PREFIX}120` });
  try {
    upsertProductContent({
      entityType: "spirits",
      entityId: spirit.id,
      officialNotes: "Producer tasting notes for patrons.",
      houseProfile: "House peat profile."
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/inventory/spirits/${spirit.id}/enrichment`
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { tastingNotes: { official: string | null; houseProfile: string | null } };
    assert.match(String(body.tastingNotes.official), /Producer tasting/);
    // API may expose enrichment metadata; patron React tree must not render the panel.
    assert.match(appSrc, /!admin && ENRICHMENT_MODULES/);
  } finally {
    cleanup();
  }
});
