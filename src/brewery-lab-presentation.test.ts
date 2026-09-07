/**
 * PR124 — Brewery Lab guest presentation + Keeper-owned fields.
 * Brewfather remains authoritative for brewing telemetry; The Smokey Vault owns
 * display_name, guest_description, tasting_notes, flavors, tags, and images.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  brewGuestStatusLabel,
  brewPresentationName,
  parseList,
  tapsForBatch
} from "./catalog.js";
import {
  mapBrewfatherBatch,
  upsertMappedBrew,
  type BrewfatherBatch
} from "./brewfather.js";
import { db } from "./db.js";
import {
  GUEST_FORBIDDEN_INVENTORY_KEYS,
  serializeGuestInventoryItem
} from "./guest-inventory-response.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken } = await import("./server.js");

const PREFIX = "pr124";
const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/brewfather-batch.json"), "utf8")
) as BrewfatherBatch;

function cleanup() {
  db.prepare(`DELETE FROM brews WHERE brewfather_id LIKE '${PREFIX}%' OR batch_name LIKE 'PR124%'`).run();
  db.prepare(`
    UPDATE taps SET
      brewery_batch='', maker='', style='', abv=0, ibu=0, tapped_date=NULL,
      remaining_l=0, notes='', tasting_notes='', image_url='', flavors='[]', tags='[]'
    WHERE brewery_batch LIKE 'PR124%'
  `).run();
}

before(() => {
  cleanup();
});

after(async () => {
  cleanup();
  await app.close();
});

test("brewPresentationName prefers Keeper display_name override", () => {
  assert.equal(
    brewPresentationName({ batch_name: "Citra Smash", style: "APA", display_name: "House Citra" }),
    "House Citra"
  );
  assert.equal(
    brewPresentationName({ batch_name: "Citra Smash", style: "APA", display_name: "" }),
    "Citra Smash"
  );
});

test("brewGuestStatusLabel maps pouring and fermenting for guests", () => {
  assert.equal(brewGuestStatusLabel("Fermenting"), "Brewing / Fermenting");
  assert.equal(brewGuestStatusLabel("Conditioning"), "Conditioning");
  assert.equal(brewGuestStatusLabel("Ready to Keg", { pouring: true }), "Pouring Now");
  assert.equal(brewGuestStatusLabel("Archived"), "Archived");
});

test("Brewfather sync preserves Keeper presentation fields while updating telemetry", () => {
  cleanup();
  const brewfatherId = `${PREFIX}-own-1`;
  const first = upsertMappedBrew(mapBrewfatherBatch({
    ...fixture,
    _id: brewfatherId,
    status: "Fermenting",
    measuredOg: 1.05,
    measuredFg: null,
    img_url: ""
  }));
  assert.equal(first.action, "inserted");

  db.prepare(`
    UPDATE brews SET
      display_name=?, guest_description=?, tasting_notes=?, flavors=?, tags=?, notes=?
    WHERE id=?
  `).run(
    "Vault Citra",
    "Bright house pale for the patio.",
    "Aroma: citrus peel\nPalate: pine\nFinish: dry",
    '["Citrus","Pine"]',
    '["house","session"]',
    "Keep cold crash overnight",
    first.id
  );

  const second = upsertMappedBrew(mapBrewfatherBatch({
    ...fixture,
    _id: brewfatherId,
    name: "Citra Smash Renamed By Brewfather",
    status: "Conditioning",
    measuredOg: 1.052,
    measuredFg: 1.011,
    img_url: ""
  }));
  assert.equal(second.action, "updated");

  const row = db.prepare("SELECT * FROM brews WHERE id=?").get(first.id) as Record<string, unknown>;
  assert.equal(row.batch_name, "Citra Smash Renamed By Brewfather");
  assert.equal(row.status, "Conditioning");
  assert.equal(row.measured_og, 1.052);
  assert.equal(row.measured_fg, 1.011);
  assert.equal(row.display_name, "Vault Citra");
  assert.equal(row.guest_description, "Bright house pale for the patio.");
  assert.equal(row.tasting_notes, "Aroma: citrus peel\nPalate: pine\nFinish: dry");
  assert.deepEqual(parseList(row.flavors), ["Citrus", "Pine"]);
  assert.deepEqual(parseList(row.tags), ["house", "session"]);
  assert.equal(row.notes, "Keep cold crash overnight");
});

test("Brewfather image fills when empty; Keeper image survives later sync", () => {
  cleanup();
  const brewfatherId = `${PREFIX}-img-1`;
  const first = upsertMappedBrew(mapBrewfatherBatch({
    ...fixture,
    _id: brewfatherId,
    img_url: "https://brewfather.app/images/example.jpg"
  }));
  const afterImport = db.prepare("SELECT * FROM brews WHERE id=?").get(first.id) as Record<string, unknown>;
  assert.equal(afterImport.image_url, "https://brewfather.app/images/example.jpg");
  assert.equal(Number(afterImport.keeper_owns_image), 0);

  db.prepare(`
    UPDATE brews SET image_url=?, keeper_owns_image=1 WHERE id=?
  `).run("/api/media/images/pr124-keeper-citra.jpg", first.id);

  upsertMappedBrew(mapBrewfatherBatch({
    ...fixture,
    _id: brewfatherId,
    status: "Completed",
    img_url: "https://brewfather.app/images/replacement.jpg"
  }));

  const afterSync = db.prepare("SELECT * FROM brews WHERE id=?").get(first.id) as Record<string, unknown>;
  assert.equal(afterSync.image_url, "/api/media/images/pr124-keeper-citra.jpg");
  assert.equal(Number(afterSync.keeper_owns_image), 1);
  assert.equal(afterSync.status, "Ready to Keg");
});

test("Guest cannot mutate brew presentation; Keeper can", async () => {
  cleanup();
  const brewId = Number(db.prepare(`
    INSERT INTO brews (batch_name, style, status, calculated_abv, tasting_notes, brewfather_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("PR124 Guest Mutate", "Pale Ale", "Fermenting", 5.2, "", `${PREFIX}-auth-1`).lastInsertRowid);

  const guestDenied = await app.inject({
    method: "PUT",
    url: `/api/inventory/brews/${brewId}`,
    payload: {
      tasting_notes: "should fail",
      guest_description: "nope"
    }
  });
  assert.equal(guestDenied.statusCode, 401);

  const token = createTestAdminToken();
  const keeperOk = await app.inject({
    method: "PUT",
    url: `/api/inventory/brews/${brewId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      display_name: "Patio Pale",
      guest_description: "Easy drinking house pale.",
      tasting_notes: "Citrus and biscuit",
      flavors: ["Citrus", "Biscuit"],
      tags: ["house"],
      image_url: "/api/media/images/pr124-patio.jpg"
    }
  });
  assert.equal(keeperOk.statusCode, 200);
  const body = keeperOk.json() as Record<string, unknown>;
  assert.equal(body.display_name, "Patio Pale");
  assert.equal(body.guest_description, "Easy drinking house pale.");
  assert.equal(body.tasting_notes, "Citrus and biscuit");
  assert.equal(body.image_url, "/api/media/images/pr124-patio.jpg");
  assert.equal(Number(body.keeper_owns_image), 1);

  const guestGet = await app.inject({ method: "GET", url: "/api/inventory/brews" });
  assert.equal(guestGet.statusCode, 200);
  const guestRows = guestGet.json() as Array<Record<string, unknown>>;
  const guestBrew = guestRows.find((row) => Number(row.id) === brewId);
  assert.ok(guestBrew);
  assert.equal(guestBrew.display_name, "Patio Pale");
  assert.equal(guestBrew.guest_description, "Easy drinking house pale.");
  assert.equal(guestBrew.tasting_notes, "Citrus and biscuit");
  assert.equal(Object.prototype.hasOwnProperty.call(guestBrew, "brewfather_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guestBrew, "keeper_owns_image"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(guestBrew, "measured_og"), false);
  for (const key of GUEST_FORBIDDEN_INVENTORY_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(guestBrew, key), false, `guest leaked ${key}`);
  }
});

test("Guest serializer keeps presentation fields and strips Brewfather internals", () => {
  const safe = serializeGuestInventoryItem("brews", {
    id: 9,
    batch_name: "PR124 Serial",
    display_name: "Serial Pale",
    style: "APA",
    guest_description: "About the beer",
    tasting_notes: "Citrus",
    flavors: '["Citrus"]',
    tags: '["house"]',
    image_url: "/api/media/images/x.jpg",
    calculated_abv: 5.4,
    status: "Fermenting",
    hops: '["Citra"]',
    brewfather_id: `${PREFIX}-secret`,
    keeper_owns_image: 1,
    measured_og: 1.05,
    measured_fg: 1.01,
    target_og: 1.048,
    target_fg: 1.01
  });
  assert.equal(safe.display_name, "Serial Pale");
  assert.equal(safe.guest_description, "About the beer");
  assert.equal(safe.tasting_notes, "Citrus");
  assert.equal(safe.hops, '["Citra"]');
  assert.equal(safe.calculated_abv, 5.4);
  assert.equal(safe.brewfather_id, undefined);
  assert.equal(safe.keeper_owns_image, undefined);
  assert.equal(safe.measured_og, undefined);
});

test("Pouring/tap linkage still matches Brewfather batch_name", () => {
  const taps = [
    { tap_number: 2, brewery_batch: "Citra Smash", remaining_l: 10, keg_size_l: 19.5 },
    { tap_number: 3, brewery_batch: "Other", remaining_l: 5, keg_size_l: 19.5 }
  ];
  assert.deepEqual(tapsForBatch(taps, "Citra Smash"), [2]);
  assert.equal(brewPresentationName({
    batch_name: "Citra Smash",
    display_name: "Vault Citra",
    style: "APA"
  }), "Vault Citra");
});

test("Brewery Lab UI prioritizes guest presentation and Keeper detail editor", () => {
  const lab = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../client/src/BreweryLab.tsx"), "utf8");
  const detail = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../client/src/BreweryLabDetail.tsx"), "utf8");
  assert.match(lab, /brewPresentationName/);
  assert.match(lab, /brewGuestStatusLabel/);
  assert.match(lab, /guest_description/);
  assert.match(lab, /BreweryLabDetail/);
  assert.doesNotMatch(lab, /OG \$\{/);
  assert.match(detail, /Edit presentation/);
  assert.match(detail, /display_name/);
  assert.match(detail, /guest_description/);
  assert.match(detail, /ImageField/);
  assert.match(detail, /Brewing details/);
  assert.match(detail, /admin && String\(brew\.brewfather_id/);
});
