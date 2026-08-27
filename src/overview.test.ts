import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverview, overviewGreeting, overviewHeroCopy } from "./overview.js";

test("overviewGreeting follows the clock", () => {
  assert.equal(overviewGreeting(new Date(2026, 7, 21, 8, 0, 0)).eyebrow, "GOOD MORNING");
  assert.equal(overviewGreeting(new Date(2026, 7, 21, 13, 0, 0)).eyebrow, "GOOD AFTERNOON");
  assert.equal(overviewGreeting(new Date(2026, 7, 21, 19, 0, 0)).eyebrow, "GOOD EVENING");
  assert.equal(overviewGreeting(new Date(2026, 7, 21, 23, 30, 0)).eyebrow, "AFTER HOURS");
  assert.equal(overviewGreeting(new Date(2026, 7, 21, 2, 0, 0)).eyebrow, "AFTER HOURS");
});

test("patron greeting is tonight at The Smokey Barrel", () => {
  const guest = overviewGreeting(new Date(2026, 7, 21, 19, 0, 0), true);
  assert.equal(guest.eyebrow, "GOOD EVENING · PATRON LOUNGE");
  assert.equal(guest.line, "Tonight at");
  assert.equal(guest.emphasize, "The Smokey Barrel.");
});

test("empty vault snapshot is zeros and a stock-the-shelf line", () => {
  const snap = buildOverview({});
  assert.equal(snap.spirits.on_shelf, 0);
  assert.equal(snap.taps.pouring, 0);
  assert.equal(snap.taps.handles, 7);
  assert.equal(snap.brews.active, 0);
  assert.equal(snap.packaged.units, 0);
  assert.equal(snap.wines.bottles, 0);
  assert.equal(snap.cocktails.ready, 0);
  assert.equal(snap.tickets.length, 0);
  assert.equal(snap.pours.length, 0);
  assert.equal(snap.keeperName, "Nick");
  assert.equal(snap.cocktails.offMenu.length, 0);
  assert.match(overviewHeroCopy(snap), /Stock the shelf/);
  assert.match(overviewHeroCopy(snap, true), /Browse the collection/);
});

test("overview counts pouring taps, shelf bottles, and ready drinks — not empty rows", () => {
  const snap = buildOverview({
    spirits: [
      { id: 1, name: "Eagle Rare", brand: "Buffalo Trace", fill_level: 75, stock_count: 1 },
      { id: 2, name: "Empty Rye", fill_level: 0, stock_count: 1 },
      { id: 3, name: "Last mezcal", fill_level: 25, stock_count: 1 }
    ],
    taps: [
      { tap_number: 1, brewery_batch: "House Pils", maker: "Vault", style: "Pilsner", abv: 5, keg_size_l: 19.5, remaining_l: 19.5, source_type: "Homebrew" },
      { tap_number: 2, brewery_batch: "None", remaining_l: 0, keg_size_l: 19.5 },
      { tap_number: 3, brewery_batch: "", remaining_l: 0, keg_size_l: 19.5 }
    ],
    brews: [
      { id: 10, batch_name: "House Pils", style: "Pilsner", status: "Ready to Keg", calculated_abv: 5 },
      { id: 11, batch_name: "Old Stout", status: "Archived" }
    ],
    packaged: [
      { id: 20, name: "Hazy IPA", brewery: "Other Half", count: 6, vessel: "Can" },
      { id: 21, name: "Gone lager", brewery: "Vault", count: 0 },
      { id: 22, name: "Last pils", brewery: "Vault", count: 1, vessel: "Can" }
    ],
    wines: [
      { id: 30, name: "Village Rouge", producer: "Foo", bottle_count: 3, type: "Red" },
      { id: 31, name: "Last bubbles", producer: "Bar", bottle_count: 1, type: "Sparkling" },
      { id: 32, name: "Drunk dry", bottle_count: 0 }
    ],
    cocktails: [
      { id: 40, name: "Negroni", readiness: "ready", bartender_fav: 1, method: "Stirred", glassware: "Rocks" },
      { id: 41, name: "Last Word", readiness: "almost", bartender_fav: 0 },
      { id: 42, name: "Paper Plane", readiness: "missing" }
    ],
    tickets: [
      { id: 50, name: "Negroni", guest_name: "Sam", notes: "Up", image_url: "" }
    ],
    pours: [
      { id: 60, module: "taps", name: "House Pils", amount: "Pint", guest_name: "", created_at: "2026-08-21T23:00:00.000Z" }
    ],
    keeperName: "Alex"
  });

  assert.equal(snap.spirits.on_shelf, 2);
  assert.equal(snap.spirits.low, 1);
  assert.equal(snap.spirits.labels, 3);
  assert.equal(snap.taps.pouring, 1);
  assert.equal(snap.taps.empty, 2);
  assert.equal(snap.taps.list[0].title, "House Pils");
  assert.equal(snap.taps.list[0].pints, 41);
  assert.equal(snap.taps.list[1].empty, true);
  assert.equal(snap.brews.active, 1);
  assert.equal(snap.brews.archived, 1);
  assert.equal(snap.brews.list[0].on_tap, "On tap 1");
  assert.equal(snap.packaged.units, 7);
  assert.equal(snap.packaged.out, 1);
  assert.equal(snap.wines.bottles, 4);
  assert.equal(snap.wines.labels, 2);
  assert.equal(snap.cocktails.ready, 1);
  assert.equal(snap.cocktails.almost, 1);
  assert.equal(snap.cocktails.favorites[0].name, "Negroni");
  assert.deepEqual(snap.cocktails.offMenu.map((drink) => drink.name), ["Negroni"]);
  assert.equal(snap.tickets[0].guest_name, "Sam");
  assert.equal(snap.pours[0].name, "House Pils");
  assert.equal(snap.keeperName, "Alex");
  assert.ok(snap.low.some((item) => item.name.includes("Last mezcal") && item.detail.includes("25%")));
  assert.ok(snap.low.some((item) => item.name.includes("Last bubbles") && item.detail === "Last bottle"));
  assert.ok(snap.low.some((item) => item.name.includes("Last pils")));
  assert.match(overviewHeroCopy(snap), /1 handle pouring/);
  assert.match(overviewHeroCopy(snap), /1 ready to mix/);
  assert.match(overviewHeroCopy(snap), /1 poured tonight/);
  assert.doesNotMatch(overviewHeroCopy(snap), /on the ticket/);
  assert.match(overviewHeroCopy(snap, true), /1 off the menu/);
  assert.match(overviewHeroCopy(snap, true), /in the lab/);
  assert.match(overviewHeroCopy(snap, true), /cold room/);
  assert.doesNotMatch(overviewHeroCopy(snap, true), /ready to mix|on the ticket/);
});

test("generic Brewfather Batch names fall back to style on Overview", () => {
  const snap = buildOverview({
    brews: [
      { id: 1, batch_name: "Batch", style: "American IPA", status: "Conditioning", calculated_abv: 6.2 },
      { id: 2, batch_name: "JUICY BARREL", style: "New England IPA", status: "Planned", calculated_abv: 6.6 }
    ]
  });
  assert.equal(snap.brews.list[0].batch_name, "JUICY BARREL");
  assert.equal(snap.brews.list.find((brew) => brew.id === 1)?.batch_name, "American IPA");
});

test("overdue wines show on cellar watch even when the rack is otherwise stocked", () => {
  const snap = buildOverview({
    wines: [
      { id: 1, name: "Village Rouge", producer: "Foo", bottle_count: 4, drink_by_date: "2020-01-01" }
    ],
    keeperName: "Sam"
  });
  assert.equal(snap.keeperName, "Sam");
  assert.ok(snap.low.some((item) => item.name.includes("Village Rouge") && item.detail.includes("Drink by 2020-01-01")));
});
