/**
 * PR150 — Overview hierarchy and responsive stat redesign.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOverview } from "./overview.js";
import { OVERVIEW_STAT_COUNT, overviewStatDefs } from "../client/src/overview-stats.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const overviewStatsSrc = readFileSync(join(root, "client/src/OverviewStats.tsx"), "utf8");

function populatedSnapshot() {
  return buildOverview({
    spirits: [
      { id: 1, name: "Eagle Rare", fill_level: 75, stock_count: 1 },
      { id: 2, name: "Low mezcal", fill_level: 20, stock_count: 1 }
    ],
    taps: [
      { tap_number: 1, brewery_batch: "House Pils", style: "Pilsner", abv: 5, keg_size_l: 19.5, remaining_l: 10 },
      { tap_number: 2, remaining_l: 0, keg_size_l: 19.5 }
    ],
    brews: [
      { id: 10, batch_name: "House Pils", status: "Conditioning", calculated_abv: 5 },
      { id: 11, batch_name: "Old Stout", status: "Archived" }
    ],
    packaged: [
      { id: 20, name: "Hazy IPA", count: 6, vessel: "Can" },
      { id: 21, name: "Gone lager", count: 0 }
    ],
    wines: [{ id: 30, name: "Village Rouge", bottle_count: 3, type: "Red" }],
    cocktails: [
      { id: 40, name: "Negroni", readiness: "ready" },
      { id: 41, name: "Last Word", readiness: "almost" }
    ]
  });
}

test("PR150 loading (no snapshot) yields no stat defs — never invented zeroes", () => {
  assert.deepEqual(overviewStatDefs(undefined, false), []);
  assert.deepEqual(overviewStatDefs(undefined, true), []);
});

test("PR150 renders all six metrics from the shared snapshot (Guest)", () => {
  const defs = overviewStatDefs(populatedSnapshot(), false);
  assert.equal(defs.length, 6);
  assert.equal(OVERVIEW_STAT_COUNT, 6);
  assert.deepEqual(defs.map((d) => d.id), ["taps", "cocktails", "spirits", "wines", "packaged_beer", "brewery"]);
  assert.deepEqual(defs.map((d) => d.label), ["On Tap", "Off the menu", "Spirits", "Wine", "Beer", "Homebrews"]);
  // Values come straight from the authoritative snapshot counts.
  assert.deepEqual(defs.map((d) => d.value), [1, 1, 2, 3, 6, 1]);
});

test("PR150 renders all six metrics from the shared snapshot (Keeper)", () => {
  const defs = overviewStatDefs(populatedSnapshot(), true);
  assert.equal(defs.length, 6);
  assert.deepEqual(defs.map((d) => d.id), ["spirits", "taps", "brewery", "packaged_beer", "wines", "cocktails"]);
  assert.deepEqual(defs.map((d) => d.value), [2, 1, 1, 6, 3, 1]);
});

test("PR150 count values are the snapshot's — not a second source", () => {
  const snap = populatedSnapshot();
  const byId = Object.fromEntries(overviewStatDefs(snap, false).map((d) => [d.id, d.value]));
  assert.equal(byId.taps, snap.taps.pouring);
  assert.equal(byId.cocktails, snap.cocktails.ready);
  assert.equal(byId.spirits, snap.spirits.on_shelf);
  assert.equal(byId.wines, snap.wines.bottles);
  assert.equal(byId.packaged_beer, snap.packaged.units);
  assert.equal(byId.brewery, snap.brews.active);
});

test("PR150 genuine zero counts still render once the snapshot loads", () => {
  const defs = overviewStatDefs(buildOverview({}), false);
  assert.equal(defs.length, 6);
  assert.ok(defs.every((d) => d.value === 0));
  // Real zeroes are present values, never omitted rows.
  assert.deepEqual(defs.map((d) => d.value), [0, 0, 0, 0, 0, 0]);
});

test("PR150 preserves each metric's existing navigation destination id", () => {
  const destinations = new Set(["spirits", "taps", "brewery", "packaged_beer", "wines", "cocktails"]);
  for (const admin of [false, true]) {
    for (const def of overviewStatDefs(populatedSnapshot(), admin)) {
      assert.ok(destinations.has(def.id), `${def.id} is a known Overview destination`);
    }
  }
});

test("PR150 removes the duplicate six-count hero sentence", () => {
  // The hero lede is now count-free prose; the count sentence formatter is gone from the client.
  assert.doesNotMatch(appSrc, /overviewHeroCopy/);
  assert.match(appSrc, /className="hero-lede">\{overviewHeroLede\(!admin\)\}/);
});

test("PR150 stat grid is a snapshot-driven component with loading/error safety", () => {
  assert.match(appSrc, /<OverviewStats snapshot=\{snap\} admin=\{admin\} loading=\{!snap && !error\} onNavigate=\{go\}\/>/);
  // The component skeletons while loading and renders nothing (not zeroes) on error.
  assert.match(overviewStatsSrc, /if \(!snapshot\) \{[\s\S]*if \(!loading\) return null;/);
  assert.match(overviewStatsSrc, /aria-busy="true"/);
  // Accessible names carry the number + label for each metric.
  assert.match(overviewStatsSrc, /aria-label=\{`\$\{stat\.value\} \$\{stat\.label\}/);
});