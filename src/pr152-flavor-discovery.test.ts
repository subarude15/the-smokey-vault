/**
 * PR152 — Bottle Library flavor discovery, search, and filter cleanup.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CANONICAL_FLAVOR_LABELS, deriveSpiritFlavors } from "../client/src/spirit-flavors.ts";
import { bottleSearchHaystack, matchesBottleSearch, spiritIsAvailable } from "../client/src/spirit-search.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const flavorsSrc = readFileSync(join(root, "client/src/spirit-flavors.ts"), "utf8");
const searchSrc = readFileSync(join(root, "client/src/spirit-search.ts"), "utf8");

/* --------------------------- Flavor derivation ---------------------------- */

test("structured flavors derive canonical facets even without tasting notes", () => {
  assert.deepEqual(deriveSpiritFlavors({ flavors: ["Vanilla", "Oak"] }), ["Vanilla", "Oak"]);
});

test("tasting-note terms derive canonical flavors in canonical order", () => {
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "Vanilla, caramel and toasted oak" }), ["Vanilla", "Caramel", "Oak"]);
});

test("flavor matching is case-insensitive", () => {
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "VANILLA over OAKY spice" }), ["Vanilla", "Oak"]);
  assert.deepEqual(deriveSpiritFlavors({ flavors: ["vanilla"] }), ["Vanilla"]);
});

test("flavors dedupe across structured flavors and tasting notes", () => {
  assert.deepEqual(
    deriveSpiritFlavors({ flavors: ["Vanilla"], tasting_notes: "vanilla and caramel" }),
    ["Vanilla", "Caramel"]
  );
});

test("junk descriptor words never become flavors", () => {
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "a long smooth finish, rich palate, a hint of nothing" }), []);
  for (const junk of ["smooth", "finish", "rich", "long", "palate", "hint"]) {
    assert.equal(CANONICAL_FLAVOR_LABELS.includes(junk), false, `${junk} must not be a facet`);
  }
});

test("multi-word canonical phrases match as whole phrases", () => {
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "brown sugar and baking spice" }), ["Brown Sugar", "Baking Spice"]);
  // The bare word "sugar" is not a canonical flavor on its own.
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "sugar water" }), []);
});

test("unrelated prose and near-miss substrings do not create false flavors", () => {
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "an approachable everyday pour" }), []);
  // pineapple/coconut must not trigger Apple/Nutty via substring.
  assert.deepEqual(deriveSpiritFlavors({ tasting_notes: "pineapple and coconut" }), ["Coconut", "Pineapple"]);
});

test("canonical vocabulary is finite and human-friendly", () => {
  assert.ok(CANONICAL_FLAVOR_LABELS.length >= 20 && CANONICAL_FLAVOR_LABELS.length <= 60);
  for (const label of ["Vanilla", "Oak", "Smoke", "Citrus", "Brown Sugar", "Baking Spice"]) {
    assert.ok(CANONICAL_FLAVOR_LABELS.includes(label), `${label} present`);
  }
});

/* -------------------------------- Search ---------------------------------- */

function rum() {
  return { name: "Diplomatico", category: "Rum", flavors: '["Vanilla"]', tasting_notes: "toffee and citrus peel", tags: '["house","sipping"]' };
}

test("multi-word search matches across category and derived flavor (vanilla rum)", () => {
  const item = rum();
  const haystack = bottleSearchHaystack(item, deriveSpiritFlavors(item));
  assert.equal(matchesBottleSearch(haystack, "vanilla rum"), true);
  assert.equal(matchesBottleSearch(haystack, "citrus gin"), false);
});

test("search tokens may match different fields and are case-insensitive", () => {
  const gin = { name: "Nikka Coffey", category: "Gin", tasting_notes: "bright citrus and juniper" };
  const haystack = bottleSearchHaystack(gin, deriveSpiritFlavors(gin));
  assert.equal(matchesBottleSearch(haystack, "citrus gin"), true);
  assert.equal(matchesBottleSearch(haystack, "CITRUS GIN"), true);
});

test("manual Keeper tags remain searchable", () => {
  const item = rum();
  const haystack = bottleSearchHaystack(item, deriveSpiritFlavors(item));
  assert.equal(matchesBottleSearch(haystack, "house"), true);
  assert.equal(matchesBottleSearch(haystack, "sipping rum"), true);
});

test("flavor aliases let inflected queries match (smoky whiskey, caramel bourbon)", () => {
  const scotch = { name: "Laphroaig 10", category: "Whiskey", sub_category: "Scotch", tasting_notes: "Intense peat smoke and a long dry finish" };
  const h1 = bottleSearchHaystack(scotch, deriveSpiritFlavors(scotch));
  assert.equal(matchesBottleSearch(h1, "smoky whiskey"), true);
  assert.equal(matchesBottleSearch(h1, "peaty scotch"), true);
  const bourbon = { name: "Makers Mark", category: "Whiskey", sub_category: "Bourbon", flavors: '["Caramel","Vanilla"]', tasting_notes: "Caramel, vanilla, and baking spice" };
  const h2 = bottleSearchHaystack(bourbon, deriveSpiritFlavors(bourbon));
  assert.equal(matchesBottleSearch(h2, "caramel bourbon"), true);
});

test("a non-matching second token prevents a result", () => {
  const item = rum();
  const haystack = bottleSearchHaystack(item, deriveSpiritFlavors(item));
  assert.equal(matchesBottleSearch(haystack, "vanilla tequila"), false);
});

/* ------------------------------ Availability ------------------------------ */

test("Guest-safe availability reads the out_of_stock flag with sane fallback", () => {
  assert.equal(spiritIsAvailable({ out_of_stock: true }), false);
  assert.equal(spiritIsAvailable({ out_of_stock: false }), true);
  assert.equal(spiritIsAvailable({ stock_count: 2 }), true);
  assert.equal(spiritIsAvailable({ stock_count: 0, fill_level: 0 }), false);
  assert.equal(spiritIsAvailable({ name: "no signal" }), true);
});

/* ------------------------------ Data safety ------------------------------- */

test("derivation and search never mutate the source flavors/tags/tasting_notes", () => {
  const item = { flavors: '["Vanilla"]', tags: '["house"]', tasting_notes: "vanilla and oak", category: "Rum" };
  const before = JSON.parse(JSON.stringify(item));
  deriveSpiritFlavors(item);
  bottleSearchHaystack(item, deriveSpiritFlavors(item));
  spiritIsAvailable(item);
  assert.deepEqual(item, before);
});

test("flavor/search helpers are pure — no AI or network calls", () => {
  for (const src of [flavorsSrc, searchSrc]) {
    assert.doesNotMatch(src, /\bfetch\s*\(/);
    assert.doesNotMatch(src, /\bapi\s*\(/);
    assert.doesNotMatch(src, /http/i);
  }
});

/* --------------------- App wiring (filter/search/UI) ---------------------- */

test("Bottle Library wires derived-flavor search, flavor + availability filters", () => {
  assert.match(appSrc, /matchesBottleSearch\(bottleSearchHaystack\(item, derived\), search\)/);
  assert.match(appSrc, /deriveSpiritFlavors\(item\)/);
  assert.match(appSrc, /spiritIsAvailable\(item\)/);
  // Flavor filter checks the derived canonical facets, not raw structured flavors.
  assert.match(appSrc, /flavor !== "All" && !derived\.some/);
});

test("Bottle Library filter row is Family / Flavor / Availability with a full clear", () => {
  assert.match(appSrc, /className="filter-row bottle-filter-row"/);
  assert.match(appSrc, /Any availability/);
  assert.match(appSrc, /On the shelf/);
  // Clear resets every filter axis, including availability.
  assert.match(appSrc, /function clearFilters\(\)\s*\{[\s\S]*setAvail\("All"\)/);
  // Filtered-empty stays distinct from a genuinely empty shelf.
  assert.match(appSrc, /No bottles match /);
});