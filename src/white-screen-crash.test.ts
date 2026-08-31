/**
 * Reproduction harness for production white-screen React crashes
 * (scan after barcode + BottleDetail → ItemForm edit).
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { parseList } from "./catalog.js";
import { db } from "./db.js";
import { buildBottleEnrichmentView } from "./ingestion/jobs/enrichment-view.js";
import { LOOKUP_SOURCE_LABELS, type LookupSource } from "./lookup-shared.js";
import { saveScanSessionBottle } from "./scan-session.js";
import { upsertProductContent } from "./ingestion/jobs/product-content.js";

/** Mirrors EnrichmentPanel FieldRow (client/src/EnrichmentPanel.tsx:114-142). */
function FieldRow({ label, field }: { label: string; field: {
  value: string | number | null;
  sourceLabel: string | null;
  confidence: number | null;
  confidenceBand: string;
  confidenceLabel: string;
  status: string;
} }) {
  const value =
    field.value == null || field.value === ""
      ? "—"
      : typeof field.value === "number"
        ? String(field.value)
        : String(field.value);
  return React.createElement(
    "div",
    { className: `enrichment-field enrichment-field-${field.status}` },
    React.createElement("span", null, label),
    React.createElement("strong", null, value),
    field.status === "missing"
      ? React.createElement("span", null, "Missing")
      : React.createElement(
          React.Fragment,
          null,
          field.sourceLabel ? React.createElement("span", null, field.sourceLabel) : null,
          React.createElement("span", null, field.confidenceLabel)
        )
  );
}

/** Mirrors EnrichmentPanel render body for the crash-prone sections. */
function EnrichmentPanelBody({ view }: { view: any }) {
  return React.createElement(
    "section",
    null,
    view.enrichment.jobs.map((job: any) =>
      React.createElement("div", { key: job.type }, job.type, job.statusLabel)
    ),
    view.enrichment.missing.length
      ? React.createElement("p", null, view.enrichment.missing.join(", "))
      : null,
    React.createElement(FieldRow, { label: "Name", field: view.identity.name }),
    React.createElement(FieldRow, { label: "Brand", field: view.identity.brand }),
    view.tastingNotes.houseProfile
      ? React.createElement("p", null, view.tastingNotes.houseProfile)
      : null
  );
}

/** Mirrors App.tsx ItemForm source chip (line 2111) — no ?? fallback. */
function SourceChip({ source }: { source?: LookupSource }) {
  if (!source || source === "not_found") return null;
  return React.createElement("span", null, LOOKUP_SOURCE_LABELS[source]);
}

/** Mirrors ImageField init (client/src/ImageField.tsx:23). */
function ImageFieldInit({ value }: { value: any }) {
  const showUrl = Boolean(value) && !value.startsWith("/api/media/images/");
  return React.createElement("div", null, String(showUrl));
}

function render(el: React.ReactElement) {
  return renderToString(el);
}

test("FieldRow crashes when field is undefined (EnrichmentPanel:114)", () => {
  assert.throws(
    () => render(React.createElement(FieldRow, { label: "Name", field: undefined as any })),
    /Cannot read properties of undefined \(reading 'value'\)/
  );
});

test("EnrichmentPanel crashes when enrichment.jobs is undefined (line 231)", () => {
  const view = {
    identity: { name: { value: "x", sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" }, brand: { value: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" } },
    enrichment: { jobs: undefined, missing: [] },
    tastingNotes: { houseProfile: null }
  };
  assert.throws(
    () => render(React.createElement(EnrichmentPanelBody, { view })),
    /Cannot read properties of undefined \(reading 'map'\)/
  );
});

test("EnrichmentPanel crashes when enrichment.missing is undefined (line 242)", () => {
  const view = {
    identity: { name: { value: "x", sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" }, brand: { value: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" } },
    enrichment: { jobs: [], missing: undefined },
    tastingNotes: { houseProfile: null }
  };
  assert.throws(
    () => render(React.createElement(EnrichmentPanelBody, { view })),
    /Cannot read properties of undefined \(reading 'length'\)/
  );
});

test("EnrichmentPanel crashes when houseProfile is a plain object (line 313-314)", () => {
  const view = {
    identity: { name: { value: "x", sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" }, brand: { value: null, sourceLabel: null, confidence: null, confidenceBand: "none", confidenceLabel: "None", status: "missing" } },
    enrichment: { jobs: [], missing: [] },
    tastingNotes: { houseProfile: { aroma: "peat", palate: "oak" } }
  };
  assert.throws(
    () => render(React.createElement(EnrichmentPanelBody, { view })),
    /Objects are not valid as a React child/
  );
});

test("houseProfile JSON string that was incorrectly parsed to object crashes; string is fine", () => {
  const raw = JSON.stringify({ aroma: "peat", palate: "oak", finish: "long", flavor_tags: ["smoke"] });
  // Incorrect parse path (what production must not do / must guard against)
  const parsed = JSON.parse(raw);
  assert.throws(
    () => render(React.createElement("p", null, parsed)),
    /Objects are not valid as a React child/
  );
  // Correct: leave as string or String()
  assert.equal(render(React.createElement("p", null, raw)).includes("aroma"), true);
});

test("LOOKUP_SOURCE_LABELS[source] without fallback does not crash (renders empty)", () => {
  const html = render(React.createElement(SourceChip, { source: "not_a_real_source" as LookupSource }));
  assert.equal(html, "<span></span>");
});

test("ImageField value.startsWith crashes on non-string value", () => {
  assert.throws(
    () => render(React.createElement(ImageFieldInit, { value: { url: "https://x" } })),
    /value.startsWith is not a function/
  );
  assert.throws(
    () => render(React.createElement(ImageFieldInit, { value: 123 })),
    /value.startsWith is not a function/
  );
});

test("ItemForm-style init with vote_* inventory fields does not crash chip render", () => {
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
  const form = {
    ...item,
    flavors: parseList(item.flavors),
    hops: parseList(item.hops),
    tags: parseList(item.tags)
  };
  assert.ok(Array.isArray(form.flavors));
  assert.equal(form.vote_score, 7.5);
  // Payload still carries vote_* into PUT body (filtered server-side by tableFields)
  const payload = { ...form, flavors: JSON.stringify(form.flavors) };
  assert.equal(payload.vote_up, 2);
  const chips = render(
    React.createElement(
      "div",
      null,
      ...form.flavors.map((v) => React.createElement("span", { key: v }, v))
    )
  );
  assert.match(chips, /Peat/);
});

test("useState(emptyStats) lazy-initializer returns SessionStats object (not a function)", () => {
  function emptyStats() {
    return { total: 0, added: 0, updated: 0, needsReview: 0, failed: 0 };
  }
  // React useState treats function initial args as lazy initializers
  function useStateLike(initial: unknown) {
    return typeof initial === "function" ? (initial as () => unknown)() : initial;
  }
  const stats = useStateLike(emptyStats) as { total: number };
  assert.equal(typeof stats, "object");
  assert.equal(stats.total, 0);
  // Regression: accidentally setting state TO the function would break stats.total + 1
  const wrong = emptyStats as unknown as { total: number };
  assert.equal(typeof wrong, "function");
  assert.equal((wrong as any).total, undefined);
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
    // Full panel body must render
    assert.doesNotThrow(() => render(React.createElement(EnrichmentPanelBody, { view })));
  } finally {
    db.prepare(`DELETE FROM spirits WHERE id=?`).run(id);
  }
});

test("houseProfile stored as JSON object string renders as text; parsed object would white-screen", () => {
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

    // If a future code path JSON.parse'd the profile before render:
    const broken = {
      ...view!,
      tastingNotes: {
        ...view!.tastingNotes,
        houseProfile: JSON.parse(view!.tastingNotes.houseProfile!) as any
      }
    };
    assert.throws(
      () => render(React.createElement(EnrichmentPanelBody, { view: broken })),
      /Objects are not valid as a React child/
    );
  } finally {
    db.prepare(`DELETE FROM product_content WHERE entity_type=? AND entity_id=?`).run("spirits", id);
    db.prepare(`DELETE FROM spirits WHERE id=?`).run(id);
  }
});

test("textChild / normalizeTextField prevent object-as-React-child white screens", async () => {
  const { normalizeTextField } = await import("./ingestion/jobs/enrichment-view.js");
  assert.equal(normalizeTextField({ aroma: "peat" }), '{"aroma":"peat"}');
  assert.equal(normalizeTextField("plain"), "plain");
  assert.equal(normalizeTextField(null), null);
  assert.equal(normalizeTextField("  "), null);

  // Client mirror of textChild
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
  assert.doesNotThrow(() =>
    render(React.createElement("p", null, textChild({ aroma: "peat", palate: "oak" })))
  );
});

test("FieldRow-safe pattern with undefined field does not crash after fix", () => {
  function SafeFieldRow({ label, field }: { label: string; field?: { value: unknown; status?: string; confidenceLabel?: string; confidenceBand?: string; sourceLabel?: string | null; confidence?: number | null } | null }) {
    if (!field) {
      return React.createElement("div", null, label, "—");
    }
    const value = field.value == null || field.value === "" ? "—" : typeof field.value === "number" ? String(field.value) : String(field.value);
    return React.createElement("div", null, label, value);
  }
  assert.doesNotThrow(() => render(React.createElement(SafeFieldRow, { label: "Name", field: undefined })));
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
  // Client renders these without String() — must be primitives
  assert.notEqual(typeof result.name, "object");
  assert.notEqual(typeof result.message, "object");
});
