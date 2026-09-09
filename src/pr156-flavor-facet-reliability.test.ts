/**
 * PR156 — Bottle Library flavor data audit + facet reliability.
 *
 * Production root cause (Case B): Keeper inventory `flavors` / `tasting_notes`
 * are often empty, while accepted enrichment tasting text lives in
 * `product_content` and was never fed into PR152 facet derivation. Flavor
 * facets were also computed globally, so Family did not constrain options.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bottleSearchHaystack, matchesBottleSearch, spiritIsAvailable } from "../client/src/spirit-search.ts";
import { db } from "./db.js";
import {
  GUEST_FORBIDDEN_ENRICHMENT_KEYS,
  GUEST_FORBIDDEN_INVENTORY_KEYS,
  GUEST_INVENTORY_FIELDS,
  serializeGuestInventoryItem,
  serializeInventoryItemForCaller
} from "./guest-inventory-response.js";
import {
  attachInventoryDisplayFlavors,
  clearProductContentForTests,
  upsertProductContent
} from "./ingestion/jobs/index.js";
import {
  coerceSpiritFlavorSelection,
  deriveSpiritFlavors,
  resolveSpiritDisplayFlavors,
  spiritFlavorFacetOptions
} from "./spirit-flavors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const PREFIX = "pr156flavor";

function cleanup() {
  db.prepare(`DELETE FROM spirits WHERE name LIKE '${PREFIX}%'`).run();
  clearProductContentForTests();
}

function insertSpirit(row: {
  name: string;
  category: string;
  flavors?: string;
  tasting_notes?: string;
  stock_count?: number;
  fill_level?: number;
}): number {
  const result = db.prepare(`
    INSERT INTO spirits (
      name, brand, category, sub_category, abv, volume_ml, fill_level,
      purchase_date, opened_date, shelf_location, upc, notes, image_url,
      stock_count, tasting_notes, flavors, tags, base_ingredient, blocked_from_ordering
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.name,
    "PR156 Distillery",
    row.category,
    "",
    40,
    750,
    row.fill_level ?? 100,
    null,
    null,
    "",
    "",
    "",
    "",
    row.stock_count ?? 1,
    row.tasting_notes ?? "",
    row.flavors ?? "[]",
    "[]",
    "",
    0
  );
  return Number(result.lastInsertRowid);
}

before(() => cleanup());
after(() => cleanup());

test("Whiskey A tasting notes derive Vanilla / Caramel / Oak", () => {
  assert.deepEqual(
    deriveSpiritFlavors({ tasting_notes: "Vanilla, caramel, toasted oak" }),
    ["Vanilla", "Caramel", "Oak"]
  );
});

test("Whiskey B tasting notes derive Smoke / Peat / Citrus", () => {
  assert.deepEqual(
    deriveSpiritFlavors({ tasting_notes: "Peaty smoke, citrus peel" }),
    ["Smoke", "Peat", "Citrus"]
  );
});

test("Gin tasting notes derive Lemon / Floral (controlled vocabulary only)", () => {
  assert.deepEqual(
    deriveSpiritFlavors({ tasting_notes: "Juniper, lemon, floral botanicals" }),
    ["Lemon", "Floral"]
  );
});

test("Rum structured flavors derive Molasses / Banana", () => {
  assert.deepEqual(
    deriveSpiritFlavors({ flavors: ["Molasses", "Banana"] }),
    ["Molasses", "Banana"]
  );
});

test("enrichment tasting text contributes without mutating inventory fields", () => {
  const item = {
    flavors: "[]",
    tasting_notes: "",
    enrichment_tasting_text: "Official notes: vanilla bean, caramelized sugar, toasted oak"
  };
  assert.deepEqual(deriveSpiritFlavors(item), ["Vanilla", "Caramel", "Oak"]);
  assert.equal(item.flavors, "[]");
  assert.equal(item.tasting_notes, "");
});

test("tags never become flavor facets", () => {
  assert.deepEqual(deriveSpiritFlavors({ flavors: "[]", tasting_notes: "" }), []);
  const haystack = bottleSearchHaystack(
    { name: "Tagged", category: "Whiskey", tags: '["vanilla","peat"]', flavors: "[]", tasting_notes: "" },
    []
  );
  assert.equal(matchesBottleSearch(haystack, "vanilla"), true);
  assert.deepEqual(resolveSpiritDisplayFlavors({ flavors: "[]", tasting_notes: "", tags: '["vanilla"]' }), []);
});

test("attachInventoryDisplayFlavors merges inventory + product_content tasting text", () => {
  cleanup();
  const id = insertSpirit({
    name: `${PREFIX} Enrichment Whiskey`,
    category: "Whiskey",
    flavors: "[]",
    tasting_notes: ""
  });
  upsertProductContent({
    entityType: "spirits",
    entityId: id,
    officialNotes: "Vanilla and caramel with toasted oak.",
    officialSourceUrl: "https://example.com/official",
    officialSourceType: "official"
  });
  const row = db.prepare(`SELECT * FROM spirits WHERE id=?`).get(id) as Record<string, unknown>;
  const attached = attachInventoryDisplayFlavors("spirits", row);
  assert.deepEqual(attached.display_flavors, ["Vanilla", "Caramel", "Oak"]);
  assert.equal(String(row.tasting_notes ?? ""), "");
  assert.equal(String(row.flavors ?? ""), "[]");
  assert.equal(attached.official_source_url, undefined);
  assert.equal(attached.official_tasting_notes, undefined);
  assert.equal(attached.house_tasting_profile, undefined);
});

test("Guest allowlist includes display_flavors and still strips Keeper secrets", () => {
  assert.ok(GUEST_INVENTORY_FIELDS.spirits.includes("display_flavors"));
  const guest = serializeGuestInventoryItem("spirits", {
    id: 1,
    name: "X",
    brand: "Y",
    category: "Whiskey",
    flavors: "[]",
    tasting_notes: "",
    display_flavors: ["Vanilla", "Oak"],
    upc: "123",
    stock_count: 9,
    fill_level: 40,
    shelf_location: "A1",
    official_source_url: "https://secret.example",
    jobs: [{ id: 1 }]
  });
  assert.deepEqual(guest.display_flavors, ["Vanilla", "Oak"]);
  for (const key of GUEST_FORBIDDEN_INVENTORY_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(guest, key), false, key);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "upc"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "stock_count"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "fill_level"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "shelf_location"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "official_source_url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guest, "jobs"), false);
  for (const key of GUEST_FORBIDDEN_ENRICHMENT_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(guest, key), false, `enrichment:${key}`);
  }
});

test("Keeper inventory serializer retains display_flavors presentation field", () => {
  const keeper = serializeInventoryItemForCaller(
    "spirits",
    { id: 1, name: "K", display_flavors: ["Peat"], upc: "keep" },
    { admin: true }
  );
  assert.deepEqual(keeper.display_flavors, ["Peat"]);
  assert.equal(keeper.upc, "keep");
});

function fixtureLibrary() {
  const items: Array<Record<string, unknown>> = [
    { id: 1, category: "Whiskey", tasting_notes: "Vanilla, caramel, toasted oak", flavors: "[]", out_of_stock: false },
    { id: 2, category: "Whiskey", tasting_notes: "Peaty smoke, citrus peel", flavors: "[]", out_of_stock: false },
    { id: 3, category: "Gin", tasting_notes: "Juniper, lemon, floral botanicals", flavors: "[]", out_of_stock: false },
    { id: 4, category: "Rum", tasting_notes: "", flavors: '["Molasses","Banana"]', out_of_stock: false },
    { id: 5, category: "Vodka", tasting_notes: "", flavors: "[]", out_of_stock: false }
  ];
  const flavorsById = new Map(items.map((item) => [Number(item.id), resolveSpiritDisplayFlavors(item)]));
  return { items, flavorsById };
}

test("Global Flavor facets include flavors present across the library", () => {
  const { items, flavorsById } = fixtureLibrary();
  const options = spiritFlavorFacetOptions({ items, flavorsById, family: "All" });
  for (const label of ["Vanilla", "Caramel", "Oak", "Smoke", "Peat", "Citrus", "Lemon", "Floral", "Molasses", "Banana"]) {
    assert.ok(options.includes(label), label);
  }
});

test("Whiskey Family constrains Flavor options (no Rum-only Banana)", () => {
  const { items, flavorsById } = fixtureLibrary();
  const options = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Whiskey",
    familyKey: "category"
  });
  for (const label of ["Vanilla", "Caramel", "Oak", "Smoke", "Peat", "Citrus"]) {
    assert.ok(options.includes(label), label);
  }
  assert.equal(options.includes("Banana"), false);
  assert.equal(options.includes("Molasses"), false);
  assert.equal(options.includes("Floral"), false);
});

test("Rum Family constrains Flavor options (no Whiskey-only Peat)", () => {
  const { items, flavorsById } = fixtureLibrary();
  const options = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Rum",
    familyKey: "category"
  });
  assert.deepEqual(options, ["Molasses", "Banana"]);
  assert.equal(options.includes("Peat"), false);
});

test("Family with no recognized flavors yields an empty option list (UI keeps All flavors)", () => {
  const { items, flavorsById } = fixtureLibrary();
  const options = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Vodka",
    familyKey: "category"
  });
  assert.deepEqual(options, []);
});

test("stale Flavor selection resets when Family changes invalidate it", () => {
  const { items, flavorsById } = fixtureLibrary();
  const whiskeyOptions = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Whiskey",
    familyKey: "category"
  });
  assert.equal(coerceSpiritFlavorSelection("Peat", whiskeyOptions), "Peat");
  const rumOptions = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Rum",
    familyKey: "category"
  });
  assert.equal(coerceSpiritFlavorSelection("Peat", rumOptions), "All");
  assert.equal(coerceSpiritFlavorSelection("Banana", rumOptions), "Banana");
});

test("Availability may further constrain Flavor options without applying Flavor itself", () => {
  const items: Array<Record<string, unknown>> = [
    { id: 1, category: "Whiskey", tasting_notes: "Vanilla and oak", flavors: "[]", out_of_stock: false },
    { id: 2, category: "Whiskey", tasting_notes: "Peaty smoke", flavors: "[]", out_of_stock: true }
  ];
  const flavorsById = new Map(items.map((item) => [Number(item.id), resolveSpiritDisplayFlavors(item)]));
  const onShelf = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Whiskey",
    availability: "available",
    isAvailable: spiritIsAvailable
  });
  assert.ok(onShelf.includes("Vanilla"));
  assert.ok(onShelf.includes("Oak"));
  assert.equal(onShelf.includes("Peat"), false);
  assert.equal(onShelf.includes("Smoke"), false);
});

test("search matches vanilla whiskey / peat whiskey / banana rum / floral gin", () => {
  const { items, flavorsById } = fixtureLibrary();
  const byId = Object.fromEntries(items.map((item) => [Number(item.id), item]));
  assert.equal(matchesBottleSearch(bottleSearchHaystack(byId[1], flavorsById.get(1)!), "vanilla whiskey"), true);
  assert.equal(matchesBottleSearch(bottleSearchHaystack(byId[2], flavorsById.get(2)!), "peat whiskey"), true);
  assert.equal(matchesBottleSearch(bottleSearchHaystack(byId[4], flavorsById.get(4)!), "banana rum"), true);
  assert.equal(matchesBottleSearch(bottleSearchHaystack(byId[3], flavorsById.get(3)!), "floral gin"), true);
  assert.equal(matchesBottleSearch(bottleSearchHaystack(byId[1], flavorsById.get(1)!), "banana whiskey"), false);
});

test("Bottle Library uses display flavors, Family-scoped facets, and stale Flavor reset", () => {
  assert.match(appSrc, /resolveSpiritDisplayFlavors\(item\)/);
  assert.match(appSrc, /spiritFlavorFacetOptions\(/);
  assert.match(appSrc, /coerceSpiritFlavorSelection\(flavor, spiritFlavorOptions\)/);
  assert.match(appSrc, /familyKey:\s*module\.kindKey/);
  assert.match(appSrc, /availability:\s*avail/);
  assert.doesNotMatch(appSrc, /deriveSpiritFlavors\(item\)/);
});
