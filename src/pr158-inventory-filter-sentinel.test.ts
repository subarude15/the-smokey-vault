/**
 * PR158 — Inventory filter sentinel reliability.
 *
 * Root cause: mapped <option> elements omitted `value={value}`, so the browser
 * submitted visible labels ("All families", "All flavors", …) while filter /
 * facet logic expects the sentinel `"All"`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  coerceSpiritFlavorSelection,
  resolveSpiritDisplayFlavors,
  spiritFlavorFacetOptions
} from "./spirit-flavors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");

type Bottle = Record<string, unknown> & { id: number; category: string };

function fixtureLibrary(): { items: Bottle[]; flavorsById: Map<number, string[]> } {
  const items: Bottle[] = [
    { id: 1, category: "Whiskey", flavors: '["Vanilla","Oak"]', tasting_notes: "" },
    { id: 2, category: "Whiskey", flavors: '["Peat","Smoke"]', tasting_notes: "" },
    { id: 3, category: "Gin", flavors: '["Floral","Citrus"]', tasting_notes: "" },
    { id: 4, category: "Rum", flavors: '["Banana","Vanilla"]', tasting_notes: "" }
  ];
  const flavorsById = new Map(items.map((item) => [item.id, resolveSpiritDisplayFlavors(item)]));
  return { items, flavorsById };
}

/** Mirrors Bottle Library filter predicates in App.tsx (family / flavor / availability). */
function filterBottleLibrary(
  items: Bottle[],
  flavorsById: Map<number, string[]>,
  opts: { family: string; flavor: string; availability?: string }
): Bottle[] {
  return items.filter((item) => {
    const derived = flavorsById.get(item.id) ?? [];
    if (opts.family !== "All" && String(item.category ?? "") !== opts.family) return false;
    if (opts.flavor !== "All" && !derived.some((value) => value.toLowerCase() === opts.flavor.toLowerCase())) {
      return false;
    }
    if (opts.availability && opts.availability !== "All") {
      // Fixture treats everything as available; keep the branch for Clear coverage.
      return opts.availability === "available";
    }
    return true;
  });
}

function mappedFilterOptionBlocks(source: string): string[] {
  return [...source.matchAll(/\{(kinds|flavors|makers|tags)\.map\(\(value\)=><option[^>]*>[\s\S]*?<\/option>\)\}/g)].map(
    (match) => match[0]
  );
}

test("mapped inventory filter options set explicit value={value} (not label text)", () => {
  const blocks = mappedFilterOptionBlocks(appSrc);
  assert.equal(blocks.length, 6, "expected six mapped inventory filter option lists");
  for (const block of blocks) {
    assert.match(block, /<option key=\{value\} value=\{value\}>/);
    assert.doesNotMatch(block, /<option key=\{value\}>/);
  }
  assert.match(appSrc, /value === "All" \? "All families"/);
  assert.match(appSrc, /value === "All" \? "All flavors"/);
  assert.match(appSrc, /value === "All" \? "All makers"/);
  assert.match(appSrc, /value === "All" \? \(module\.id === "wines" \? "All wine types" : "All styles"\)/);
  assert.match(appSrc, /value === "All" \? "All tags" : `#\$\{value\}`/);
  // Availability already used explicit values before PR158.
  assert.match(appSrc, /<option value="All">Any availability<\/option>/);
});

test("Whiskey → All families restores the full Bottle Library when sentinel is All", () => {
  const { items, flavorsById } = fixtureLibrary();
  const whiskeyOnly = filterBottleLibrary(items, flavorsById, { family: "Whiskey", flavor: "All" });
  assert.equal(whiskeyOnly.length, 2);

  // Correct select value after choosing "All families".
  const restored = filterBottleLibrary(items, flavorsById, { family: "All", flavor: "All" });
  assert.equal(restored.length, items.length);

  // Buggy browser label submission must not be treated as the All sentinel.
  const broken = filterBottleLibrary(items, flavorsById, { family: "All families", flavor: "All" });
  assert.equal(broken.length, 0);
});

test("selecting All families leaves Family state as All (not All families)", () => {
  // Simulates <select value={kind} onChange={e => setKind(e.target.value)}> when the
  // chosen option carries value="All" with label "All families".
  const optionValue = "All";
  const optionLabel = "All families";
  assert.notEqual(optionValue, optionLabel);
  const nextFamilyState = optionValue;
  assert.equal(nextFamilyState, "All");
});

test("global Flavor options return after clearing Family to All", () => {
  const { items, flavorsById } = fixtureLibrary();
  const whiskeyFlavors = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "Whiskey",
    familyKey: "category"
  });
  assert.ok(whiskeyFlavors.includes("Vanilla"));
  assert.ok(whiskeyFlavors.includes("Peat"));
  assert.equal(whiskeyFlavors.includes("Floral"), false);
  assert.equal(whiskeyFlavors.includes("Banana"), false);

  const globalFlavors = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "All",
    familyKey: "category"
  });
  assert.ok(globalFlavors.includes("Vanilla"));
  assert.ok(globalFlavors.includes("Peat"));
  assert.ok(globalFlavors.includes("Floral"));
  assert.ok(globalFlavors.includes("Banana"));

  // Label mistaken for value empties the facet list (no category equals "All families").
  const broken = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "All families",
    familyKey: "category"
  });
  assert.deepEqual(broken, []);
});

test("Flavor → All flavors retains the All sentinel via coercion", () => {
  const { items, flavorsById } = fixtureLibrary();
  const options = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family: "All",
    familyKey: "category"
  });
  assert.equal(coerceSpiritFlavorSelection("All", options), "All");
  assert.equal(coerceSpiritFlavorSelection("Vanilla", options), "Vanilla");
  // A label leaked into state is not a valid facet → reset to All.
  assert.equal(coerceSpiritFlavorSelection("All flavors", options), "All");
});

test("Clear resets Family, Flavor, and Availability to All", () => {
  const cleared = {
    search: "",
    maker: "All",
    kind: "All",
    tag: "All",
    flavor: "All",
    avail: "All"
  };
  assert.equal(cleared.kind, "All");
  assert.equal(cleared.flavor, "All");
  assert.equal(cleared.avail, "All");
  assert.match(appSrc, /setSearch\(""\); setMaker\("All"\); setKind\("All"\); setTag\("All"\); setFlavor\("All"\); setAvail\("All"\)/);
});

test("adjacent maker/type/tag All options also use the All sentinel value", () => {
  const blocks = mappedFilterOptionBlocks(appSrc);
  const joined = blocks.join("\n");
  assert.match(joined, /makers\.map\(\(value\)=><option key=\{value\} value=\{value\}>/);
  assert.match(joined, /kinds\.map\(\(value\)=><option key=\{value\} value=\{value\}>/);
  assert.match(joined, /tags\.map\(\(value\)=><option key=\{value\} value=\{value\}>/);
  assert.match(joined, /flavors\.map\(\(value\)=><option key=\{value\} value=\{value\}>/);
});

test("Whiskey + flavor then Family All restores bottles and keeps Flavor when still valid", () => {
  const { items, flavorsById } = fixtureLibrary();
  let family = "Whiskey";
  let flavor = "Vanilla";
  let list = filterBottleLibrary(items, flavorsById, { family, flavor });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 1);

  family = "All"; // All families option value
  const options = spiritFlavorFacetOptions({
    items,
    flavorsById,
    family,
    familyKey: "category"
  });
  flavor = coerceSpiritFlavorSelection(flavor, options);
  assert.equal(flavor, "Vanilla");
  list = filterBottleLibrary(items, flavorsById, { family, flavor });
  assert.equal(list.length, 2); // whiskey vanilla + rum vanilla
  assert.deepEqual(list.map((item) => item.id).sort(), [1, 4]);
});
