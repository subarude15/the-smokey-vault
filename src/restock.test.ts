import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRestockList, restockSummary } from "./restock.js";

test("restock lists empty and quarter-full spirits, last wines, and cold-room leftovers", () => {
  const items = buildRestockList({
    spirits: [
      { id: 1, name: "Eagle Rare", brand: "Buffalo Trace", fill_level: 75, stock_count: 1 },
      { id: 2, name: "Empty Rye", brand: "WT", fill_level: 0, stock_count: 1 },
      { id: 3, name: "Low mezcal", fill_level: 25, stock_count: 1 }
    ],
    wines: [
      { id: 10, name: "Village Rouge", producer: "Foo", bottle_count: 3 },
      { id: 11, name: "Last bubbles", producer: "Bar", bottle_count: 1 },
      { id: 12, name: "Drunk dry", producer: "Baz", bottle_count: 0 }
    ],
    packaged: [
      { id: 20, name: "Hazy IPA", brewery: "Other Half", count: 6, vessel: "Can" },
      { id: 21, name: "Gone lager", brewery: "Vault", count: 0, vessel: "Can" },
      { id: 22, name: "Last pils", brewery: "Vault", count: 1, vessel: "Can" }
    ]
  });
  const names = items.map((item) => item.name);
  assert.ok(names.some((name) => name.includes("Empty Rye")));
  assert.ok(names.some((name) => name.includes("Low mezcal")));
  assert.ok(!names.some((name) => name.includes("Eagle Rare")));
  assert.ok(names.some((name) => name.includes("Last bubbles")));
  assert.ok(!names.some((name) => name.includes("Drunk dry")));
  assert.ok(names.some((name) => name.includes("Gone lager")));
  assert.ok(names.some((name) => name.includes("Last pils")));
  assert.ok(!names.some((name) => name.includes("Hazy IPA")));
  assert.equal(restockSummary(items).open, items.length);
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

test("checked restock keys stay on the list until the shelf recovers", () => {
  const items = buildRestockList({
    spirits: [{ id: 2, name: "Empty Rye", fill_level: 0, stock_count: 1 }],
    got: ["spirits:2"]
  });
  assert.equal(items[0].got, true);
  assert.equal(restockSummary(items).open, 0);
  assert.equal(restockSummary(items).total, 1);
});
