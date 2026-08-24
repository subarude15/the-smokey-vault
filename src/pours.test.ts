import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { listTonightPours, maybeInventoryPour, nightStart, recordPour } from "./pours.js";

function wipePours() {
  db.prepare("DELETE FROM pours").run();
}

test("nightStart rolls at 4am", () => {
  const morning = nightStart(new Date(2026, 7, 21, 10, 0, 0));
  assert.equal(morning.getHours(), 4);
  assert.equal(morning.getDate(), 21);
  const beforeFour = nightStart(new Date(2026, 7, 21, 3, 59, 0));
  assert.equal(beforeFour.getHours(), 4);
  assert.equal(beforeFour.getDate(), 20);
  const atFour = nightStart(new Date(2026, 7, 21, 4, 0, 0));
  assert.equal(atFour.getDate(), 21);
});

test("inventory pours log fill, pint, and count drops — not unrelated edits", () => {
  wipePours();
  try {
    assert.equal(maybeInventoryPour("spirits", { id: 1, name: "Eagle Rare", fill_level: 75 }, { id: 1, name: "Eagle Rare", fill_level: 50 })?.amount, "Pour");
    assert.equal(maybeInventoryPour("spirits", { id: 1, name: "Eagle Rare", fill_level: 50 }, { id: 1, name: "Eagle Rare", fill_level: 50, notes: "tasting" }), null);
    assert.equal(maybeInventoryPour("taps", { id: 2, brewery_batch: "House Pils", maker: "Vault", remaining_l: 10 }, { id: 2, brewery_batch: "House Pils", maker: "Vault", remaining_l: 9.5 })?.amount, "Pint");
    assert.equal(maybeInventoryPour("wines", { id: 3, name: "Village Rouge", bottle_count: 3 }, { id: 3, name: "Village Rouge", bottle_count: 2 })?.amount, "Bottle");
    assert.equal(maybeInventoryPour("packaged_beer", { id: 4, name: "Hazy", count: 6 }, { id: 4, name: "Hazy", count: 5 })?.amount, "One");
    const tonight = listTonightPours();
    assert.ok(tonight.length >= 4);
    assert.ok(tonight.some((pour) => pour.name.includes("Eagle Rare")));
  } finally {
    wipePours();
  }
});

test("ticket pours keep the guest name", () => {
  wipePours();
  try {
    const pour = recordPour({ module: "cocktails", name: "Negroni", amount: "Ticket", guest_name: "Sam" });
    assert.equal(pour.guest_name, "Sam");
    assert.equal(listTonightPours()[0].name, "Negroni");
  } finally {
    wipePours();
  }
});
