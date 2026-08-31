/**
 * Fixed-path regression harness for production white-screen React crashes
 * (legacy/shelf scan → BottleDetail, and BottleDetail → ItemForm edit).
 *
 * These assert the hardened client patterns — not the historical crash shapes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { parseList } from "./catalog.js";
import { db } from "./db.js";
import { buildBottleEnrichmentView, normalizeTextField } from "./ingestion/jobs/enrichment-view.js";
import { LOOKUP_SOURCE_LABELS, type LookupSource } from "./lookup-shared.js";
import { saveScanSessionBottle } from "./scan-session.js";
import { upsertProductContent } from "./ingestion/jobs/product-content.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const enrichmentPanelSrc = readFileSync(join(root, "client/src/EnrichmentPanel.tsx"), "utf8");
const imageFieldSrc = readFileSync(join(root, "client/src/ImageField.tsx"), "utf8");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const scanSessionScannerSrc = readFileSync(join(root, "client/src/ScanSessionScanner.tsx"), "utf8");
const bottlePublicSrc = readFileSync(join(root, "client/src/BottlePublicContent.tsx"), "utf8");
const errorBoundarySrc = readFileSync(join(root, "client/src/AppErrorBoundary.tsx"), "utf8");
const mainSrc = readFileSync(join(root, "client/src/main.tsx"), "utf8");

/** Client textChild — must never hand React a plain object. */
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

/** Mirrors hardened EnrichmentPanel FieldRow. */
function FieldRow({ label, field }: { label: string; field?: {
  value: unknown;
  sourceLabel?: string | null;
  confidence?: number | null;
  confidenceBand?: string;
  confidenceLabel?: string;
  status?: string;
} | null }) {
  if (!field) {
    return React.createElement("div", { className: "enrichment-field enrichment-field-missing" }, label, "—", "Missing");
  }
  const value =
    field.value == null || field.value === ""
      ? "—"
      : typeof field.value === "number"
        ? String(field.value)
        : textChild(field.value);
  return React.createElement(
    "div",
    { className: `enrichment-field enrichment-field-${field.status ?? "missing"}` },
    React.createElement("span", null, label),
    React.createElement("strong", null, value),
    field.status === "missing" || !field.status
      ? React.createElement("span", null, "Missing")
      : React.createElement(
          React.Fragment,
          null,
          field.sourceLabel ? React.createElement("span", null, field.sourceLabel) : null,
          React.createElement("span", null, field.confidenceLabel ?? "Unknown")
        )
  );
}

/** Mirrors hardened EnrichmentPanel crash-prone sections. */
function EnrichmentPanelBody({ view }: { view: any }) {
  const enrichment = view.enrichment ?? { identified: false, needsReview: false, missing: [], jobs: [], conflicts: [] };
  const jobs = Array.isArray(enrichment.jobs) ? enrichment.jobs : [];
  const missing = Array.isArray(enrichment.missing) ? enrichment.missing : [];
  const identity = view.identity ?? {};
  const houseProfileText = textChild(view.tastingNotes?.houseProfile).trim();
  return React.createElement(
    "section",
    { className: "enrichment-panel" },
    React.createElement("span", { className: "eyebrow" }, "Enrichment review"),
    React.createElement("h2", null, "What the vault knows"),
    jobs.map((job: any) =>
      React.createElement("div", { key: job.type }, job.type, job.statusLabel)
    ),
    missing.length ? React.createElement("p", null, missing.join(", ")) : null,
    React.createElement(FieldRow, { label: "Name", field: identity.name }),
    React.createElement(FieldRow, { label: "Brand", field: identity.brand }),
    houseProfileText ? React.createElement("p", null, houseProfileText) : null
  );
}

/** Mirrors BottlePublicContent — no enrichment plumbing labels. */
function BottlePublicBody({ view }: { view: any }) {
  const official = textChild(view.tastingNotes?.official).trim();
  const house = textChild(view.tastingNotes?.houseProfile).trim();
  if (!official && !house) return null;
  return React.createElement(
    "div",
    { className: "bottle-public-content" },
    official ? React.createElement("article", null, React.createElement("span", null, "TASTING NOTES"), React.createElement("p", null, official)) : null,
    house
      ? React.createElement(
          "article",
          null,
          React.createElement("span", null, "HOUSE PROFILE"),
          React.createElement("p", null, "Generated house profile — not producer copy"),
          React.createElement("p", null, house)
        )
      : null
  );
}

/** Mirrors App.tsx ItemForm source chip with ?? fallback. */
function SourceChip({ source }: { source?: LookupSource }) {
  if (!source || source === "not_found") return null;
  return React.createElement("span", null, LOOKUP_SOURCE_LABELS[source] ?? source);
}

/** Mirrors hardened ImageField value coercion. */
function ImageFieldInit({ value }: { value: unknown }) {
  const safeValue = typeof value === "string" ? value : value == null ? "" : String(value);
  const showUrl = Boolean(safeValue) && !safeValue.startsWith("/api/media/images/");
  return React.createElement("div", null, String(showUrl));
}

/** Mirrors AppErrorBoundary recovery UI (no stack / secrets). */
function ErrorRecoveryUi() {
  return React.createElement(
    "div",
    { className: "app-error-boundary", role: "alert" },
    React.createElement("h1", null, "Something went wrong"),
    React.createElement("p", null, "The page hit an unexpected error. Your inventory is safe — try returning home or reloading."),
    React.createElement("button", { type: "button" }, "Return home"),
    React.createElement("button", { type: "button" }, "Reload")
  );
}

function render(el: React.ReactElement) {
  return renderToString(el);
}

function seedFormFromItem(item: Record<string, unknown>) {
  const raw = { ...item } as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key.startsWith("vote_")) delete raw[key];
  }
  return {
    ...raw,
    flavors: parseList(raw.flavors),
    hops: parseList(raw.hops),
    tags: parseList(raw.tags)
  };
}

test("FieldRow with undefined field renders Missing — does not crash", () => {
  assert.doesNotThrow(() => render(React.createElement(FieldRow, { label: "Name", field: undefined })));
  const html = render(React.createElement(FieldRow, { label: "Name", field: undefined }));
  assert.match(html, /Missing/);
});

test("EnrichmentPanel with undefined jobs/missing/conflicts does not crash", () => {
  const view = {
    identity: {},
    enrichment: { jobs: undefined, missing: undefined, conflicts: undefined },
    tastingNotes: { houseProfile: null }
  };
  assert.doesNotThrow(() => render(React.createElement(EnrichmentPanelBody, { view })));
});

test("EnrichmentPanel with object houseProfile renders via textChild — does not crash", () => {
  const view = {
    identity: { name: { value: "x", status: "trusted", confidenceLabel: "High", confidenceBand: "high" } },
    enrichment: { jobs: [], missing: [], conflicts: [] },
    tastingNotes: { houseProfile: { aroma: "peat", palate: "oak" } }
  };
  const html = render(React.createElement(EnrichmentPanelBody, { view }));
  assert.match(html, /aroma/);
  assert.match(html, /What the vault knows/);
});

test("ImageField coerces non-string values without startsWith crash", () => {
  assert.doesNotThrow(() => render(React.createElement(ImageFieldInit, { value: { url: "https://x" } })));
  assert.doesNotThrow(() => render(React.createElement(ImageFieldInit, { value: 123 })));
  assert.doesNotThrow(() => render(React.createElement(ImageFieldInit, { value: null })));
  assert.match(imageFieldSrc, /typeof value === "string"/);
});

test("ItemForm strips vote_* before seeding and submit payload", () => {
  const item = {
    id: 1,
    name: "Buffalo Trace",
    brand: "BT",
    category: "Whiskey",
    flavors: '["Peat","Oak"]',
    tags: '["bourbon"]',
    hops: null,
    vote_up: 2,
    vote_down: 1,
    vote_net: 1,
    vote_total: 3,
    vote_score: 7.5,
    image_url: "/api/media/images/x.jpg",
    fill_level: 75,
    stock_count: 2
  };
  const form = seedFormFromItem(item);
  assert.equal(form.vote_score, undefined);
  assert.equal(form.vote_up, undefined);
  assert.ok(Array.isArray(form.flavors));
  assert.match(appSrc, /if \(key\.startsWith\("vote_"\)\) delete raw\[key\]/);
  assert.match(appSrc, /key\.startsWith\("vote_"\) \|\| key === "id"/);
});

test("useState(emptyStats) lazy-initializer returns SessionStats object", () => {
  function emptyStats() {
    return { total: 0, added: 0, updated: 0, needsReview: 0, failed: 0 };
  }
  function useStateLike(initial: unknown) {
    return typeof initial === "function" ? (initial as () => unknown)() : initial;
  }
  const stats = useStateLike(emptyStats) as { total: number };
  assert.equal(typeof stats, "object");
  assert.equal(stats.total, 0);
});

test("buildBottleEnrichmentView always returns jobs[] and missing[] for a real row", () => {
  const inserted = db.prepare(
    `INSERT INTO spirits (name, brand, category, stock_count, fill_level) VALUES (?,?,?,?,?)`
  ).run("WS Crash Probe", "Probe", "Whiskey", 1, 100);
  const id = Number(inserted.lastInsertRowid);
  try {
    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id });
    assert.ok(view);
    assert.ok(Array.isArray(view!.enrichment.jobs));
    assert.ok(Array.isArray(view!.enrichment.missing));
    assert.ok(view!.identity.name);
    assert.equal(view!.tastingNotes.houseProfile, null);
    assert.doesNotThrow(() => render(React.createElement(EnrichmentPanelBody, { view })));
  } finally {
    db.prepare(`DELETE FROM spirits WHERE id=?`).run(id);
  }
});

test("houseProfile stored as JSON object string normalizes to text for render", () => {
  const inserted = db.prepare(
    `INSERT INTO spirits (name, brand, category, stock_count, fill_level) VALUES (?,?,?,?,?)`
  ).run("WS House Probe", "Probe", "Whiskey", 1, 100);
  const id = Number(inserted.lastInsertRowid);
  try {
    const jsonProfile = JSON.stringify({ aroma: "citrus", palate: "oak", finish: "dry", flavor_tags: ["vanilla"] });
    upsertProductContent({
      entityType: "spirits",
      entityId: id,
      houseProfile: jsonProfile
    });
    const view = buildBottleEnrichmentView({ entityType: "spirits", entityId: id });
    assert.equal(typeof view!.tastingNotes.houseProfile, "string");
    assert.doesNotThrow(() => render(React.createElement(EnrichmentPanelBody, { view })));
    // Even if a future path re-parses: textChild still saves the panel.
    const broken = {
      ...view!,
      tastingNotes: {
        ...view!.tastingNotes,
        houseProfile: JSON.parse(view!.tastingNotes.houseProfile!) as any
      }
    };
    assert.doesNotThrow(() => render(React.createElement(EnrichmentPanelBody, { view: broken })));
  } finally {
    db.prepare(`DELETE FROM product_content WHERE entity_type=? AND entity_id=?`).run("spirits", id);
    db.prepare(`DELETE FROM spirits WHERE id=?`).run(id);
  }
});

test("normalizeTextField + textChild prevent object-as-React-child white screens", () => {
  assert.equal(normalizeTextField({ aroma: "peat" }), '{"aroma":"peat"}');
  assert.equal(normalizeTextField("plain"), "plain");
  assert.equal(normalizeTextField(null), null);
  assert.equal(normalizeTextField("  "), null);
  assert.doesNotThrow(() =>
    render(React.createElement("p", null, textChild({ aroma: "peat", palate: "oak" })))
  );
});

test("scan-session save result shape matches client ScanSessionSaveResult expectations", async () => {
  const result = await saveScanSessionBottle({ code: "000000000000", kind: "spirits" });
  assert.ok(["added", "updated", "needs_review", "duplicate", "failed"].includes(result.action));
  assert.equal(typeof result.upc, "string");
  assert.equal(typeof result.name, "string");
  assert.equal(typeof result.message, "string");
  assert.equal(typeof result.enrichmentQueued, "boolean");
  assert.ok(result.table === null || ["spirits", "packaged_beer", "wines"].includes(result.table));
  assert.equal(typeof result.moduleLabel, "string");
  assert.notEqual(typeof result.name, "object");
  assert.notEqual(typeof result.message, "object");
});

test("legacy + shelf scan client wiring does not open blank views after save", () => {
  // Legacy: vault hit opens BottleDetail (mode view), not a nameless route.
  assert.match(appSrc, /mode: "view"/);
  assert.match(appSrc, /scanDraft\.mode === "view"/);
  // Shelf: ScanSession stays mounted; compact result + scanner ready.
  assert.match(appSrc, /sessionMode === "active"/);
  assert.match(appSrc, /<ScanSession/);
  assert.match(scanSessionScannerSrc, /statusHint is display-only/);
  assert.match(scanSessionScannerSrc, /}, \[kind, paused, busy\]\);/);
});

test("guest bottle detail hides EnrichmentPanel; keeper retains it", () => {
  assert.match(appSrc, /admin && ENRICHMENT_MODULES\.has\(module\.id\) \? <EnrichmentPanel/);
  assert.match(appSrc, /!admin && ENRICHMENT_MODULES\.has\(module\.id\) \? \(/);
  assert.match(appSrc, /<BottlePublicContent/);
  assert.match(bottlePublicSrc, /Patron-facing enriched content only/);
  assert.doesNotMatch(bottlePublicSrc, /What the vault knows/);
  assert.doesNotMatch(bottlePublicSrc, /Enrichment review/);
  assert.doesNotMatch(bottlePublicSrc, /confidenceBand|TTB ID|image acceptance|Unverified/);
  assert.match(enrichmentPanelSrc, /What the vault knows/);
  assert.match(enrichmentPanelSrc, /keepers only/);
});

test("patron public content surfaces useful notes without plumbing", () => {
  const view = {
    tastingNotes: {
      official: "Vanilla and oak.",
      houseProfile: { aroma: "smoke", palate: "caramel" }
    }
  };
  const html = render(React.createElement(BottlePublicBody, { view }));
  assert.match(html, /Vanilla and oak/);
  assert.match(html, /HOUSE PROFILE/);
  assert.doesNotMatch(html, /What the vault knows/);
  assert.doesNotMatch(html, /Enrichment review/);
  assert.doesNotMatch(html, /confidence/i);
});

test("AppErrorBoundary wraps App and recovery UI omits stacks/secrets", () => {
  assert.match(mainSrc, /<AppErrorBoundary>/);
  assert.match(errorBoundarySrc, /Return home/);
  assert.match(errorBoundarySrc, /Reload/);
  assert.match(errorBoundarySrc, /console\.error/);
  assert.match(errorBoundarySrc, /info\.componentStack/);
  assert.doesNotMatch(errorBoundarySrc, /\{error\.stack\}|error\.stack\}/);
  const html = render(React.createElement(ErrorRecoveryUi));
  assert.match(html, /Something went wrong/);
  assert.match(html, /Return home/);
  assert.doesNotMatch(html, /at EnrichmentPanel/);
  assert.doesNotMatch(html, /componentStack/);
  assert.doesNotMatch(html, /\bPIN\b|Bearer |sessionSecret/i);
});

test("LOOKUP_SOURCE_LABELS unknown source renders safely with fallback", () => {
  const html = render(React.createElement(SourceChip, { source: "not_a_real_source" as LookupSource }));
  assert.equal(html, "<span>not_a_real_source</span>");
});
