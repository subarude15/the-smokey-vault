import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRestockList, createWanted, deleteWanted, parseRestockThresholds, restockSummary } from "./restock.js";

test("restock lists empty and quarter-full spirits, last wines, and cans below 3", () => {
  const items = buildRestockList({
    spirits: [
      { id: 1, name: "Eagle Rare", brand: "Buffalo Trace", fill_level: 75, stock_count: 1 },
      { id: 2, name: "Empty Rye", brand: "WT", fill_level: 0, stock_count: 1 },
      { id: 3, name: "Low mezcal", fill_level: 25, stock_count: 1 },
      { id: 4, name: "Spare gin", fill_level: 0, stock_count: 3 }
    ],
    wines: [
      { id: 10, name: "Village Rouge", producer: "Foo", bottle_count: 3 },
      { id: 11, name: "Last bubbles", producer: "Bar", bottle_count: 1 },
      { id: 12, name: "Drunk dry", producer: "Baz", bottle_count: 0 }
    ],
    packaged: [
      { id: 20, name: "Hazy IPA", brewery: "Other Half", count: 6, vessel: "Can" },
      { id: 21, name: "Gone lager", brewery: "Vault", count: 0, vessel: "Can" },
      { id: 22, name: "Last pils", brewery: "Vault", count: 1, vessel: "Can" },
      { id: 23, name: "Two left stout", brewery: "Vault", count: 2, vessel: "Can" }
    ]
  });
  const names = items.map((item) => item.name);
  assert.ok(names.some((name) => name.includes("Empty Rye")));
  assert.ok(names.some((name) => name.includes("Low mezcal")));
  assert.ok(!names.some((name) => name.includes("Eagle Rare")));
  assert.ok(!names.some((name) => name.includes("Spare gin")));
  assert.ok(names.some((name) => name.includes("Last bubbles")));
  assert.ok(!names.some((name) => name.includes("Drunk dry")));
  assert.ok(!names.some((name) => name.includes("Village Rouge")));
  assert.ok(names.some((name) => name.includes("Gone lager")));
  assert.ok(names.some((name) => name.includes("Last pils")));
  assert.ok(names.some((name) => name.includes("Two left stout")));
  assert.ok(!names.some((name) => name.includes("Hazy IPA")));
  assert.equal(restockSummary(items).open, items.length);
});

test("restock cutoffs follow saved thresholds", () => {
  const items = buildRestockList({
    thresholds: { packagedBelow: 6, spiritFill: 0, wineBelow: 4 },
    spirits: [
      { id: 2, name: "Empty Rye", fill_level: 0, stock_count: 1 },
      { id: 3, name: "Low mezcal", fill_level: 25, stock_count: 1 }
    ],
    wines: [
      { id: 10, name: "Village Rouge", producer: "Foo", bottle_count: 3 },
      { id: 11, name: "Last bubbles", producer: "Bar", bottle_count: 1 }
    ],
    packaged: [
      { id: 20, name: "Hazy IPA", brewery: "Other Half", count: 6, vessel: "Can" },
      { id: 24, name: "Four pack", brewery: "Vault", count: 4, vessel: "Can" }
    ]
  });
  const names = items.map((item) => item.name);
  assert.ok(names.some((name) => name.includes("Empty Rye")));
  assert.ok(!names.some((name) => name.includes("Low mezcal")));
  assert.ok(names.some((name) => name.includes("Village Rouge")));
  assert.ok(names.some((name) => name.includes("Last bubbles")));
  assert.ok(names.some((name) => name.includes("Four pack")));
  assert.ok(!names.some((name) => name.includes("Hazy IPA")));
});

test("restock threshold parser keeps empty-only fill and ignores junk", () => {
  assert.deepEqual(parseRestockThresholds(undefined), { packagedBelow: 3, spiritFill: 25, wineBelow: 2 });
  assert.equal(parseRestockThresholds({ restockSpiritFill: "0" }).spiritFill, 0);
  assert.equal(parseRestockThresholds({ restockPackagedBelow: "12" }).packagedBelow, 12);
  assert.equal(parseRestockThresholds({ restockPackagedBelow: "5" }).packagedBelow, 3);
  assert.equal(parseRestockThresholds({ restockSpiritFill: "100" }).spiritFill, 25);
});

test("restock asks for missing bottles on favorites and the one-away cocktail", () => {
  const items = buildRestockList({
    cocktails: [
      { name: "Negroni", bartender_fav: 1, readiness: "missing", missing: ["30 ml Campari", "30 ml gin"] },
      { name: "Last Word", bartender_fav: 0, readiness: "almost", missing: ["22 ml Green Chartreuse"] },
      { name: "Paper Plane", bartender_fav: 0, readiness: "missing", missing: ["Aperol", "Amaro Nonino"] }
    ]
  });
  const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
  assert.ok(byKey["need:campari"]);
  assert.match(byKey["need:campari"].reason, /Negroni/);
  assert.ok(byKey["need:green chartreuse"]);
  assert.match(byKey["need:green chartreuse"].reason, /Last Word/);
  assert.ok(!items.some((item) => /aperol/i.test(item.name)));
});

test("wanted bottles stay on restock until deleted", () => {
  const items = buildRestockList({
    wanted: [
      { id: 1, name: "Green Chartreuse", note: "The 750 at Total Wine", label: "bottle" },
      { id: 2, name: "Orgeat", note: "", label: "mixer" }
    ],
    got: ["wanted:1"]
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "wanted");
  assert.equal(items.find((item) => item.name === "Green Chartreuse")?.got, true);
  assert.match(items.find((item) => item.name === "Orgeat")?.reason ?? "", /mixer/i);
  assert.equal(restockSummary(items).open, 1);
});

test("wanted list rejects blanks and duplicate names", () => {
  const a = createWanted({ name: "  St. Germain  ", label: "bottle", note: "for last word riffs" });
  try {
    assert.equal(a.name, "St. Germain");
    assert.equal(a.label, "bottle");
    assert.throws(() => createWanted({ name: "st. germain" }), /already/i);
    assert.throws(() => createWanted({ name: "   " }), /name/i);
    assert.equal(deleteWanted(a.id), true);
    assert.equal(deleteWanted(a.id), false);
  } finally {
    deleteWanted(a.id);
  }
});

test("checked restock keys stay on the list until the shelf recovers", () => {
  const items = buildRestockList({
    spirits: [{ id: 2, name: "Empty Rye", fill_level: 0, stock_count: 1 }],
    got: ["spirits:2"]
  });
  assert.equal(items[0].got, true);
  assert.equal(restockSummary(items).open, 0);
  assert.equal(restockSummary(items).total, 1);
});
