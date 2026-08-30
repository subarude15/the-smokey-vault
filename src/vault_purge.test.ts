import assert from "node:assert/strict";
import test from "node:test";
import { db } from "./db.js";
import { createReview } from "./reviews.js";
import { castVote } from "./votes.js";
import { castDailyVote } from "./speakeasy.js";
import {
  cutoffForWindow,
  emptyVault,
  previewVaultPurge,
  PURGE_CONFIRM,
  sqliteUtc
} from "./vault_purge.js";

function wipeShelves() {
  db.prepare("DELETE FROM votes").run();
  db.prepare("DELETE FROM reviews").run();
  db.prepare("DELETE FROM daily_votes").run();
  db.prepare("DELETE FROM spirits").run();
  db.prepare("DELETE FROM packaged_beer").run();
  db.prepare("DELETE FROM wines").run();
}

function insertSpirit(name: string, createdAt: string) {
  const result = db.prepare(
    "INSERT INTO spirits(name, category, created_at) VALUES(?, 'Whiskey', ?)"
  ).run(name, createdAt);
  return Number(result.lastInsertRowid);
}

function insertBeer(name: string, createdAt: string) {
  const result = db.prepare(
    "INSERT INTO packaged_beer(name, created_at) VALUES(?, ?)"
  ).run(name, createdAt);
  return Number(result.lastInsertRowid);
}

function insertWine(name: string, createdAt: string) {
  const result = db.prepare(
    "INSERT INTO wines(name, created_at) VALUES(?, ?)"
  ).run(name, createdAt);
  return Number(result.lastInsertRowid);
}

test("sqliteUtc formats UTC without millis or Z", () => {
  assert.equal(sqliteUtc(new Date("2026-08-30T19:30:45.123Z")), "2026-08-30 19:30:45");
});

test("cutoffForWindow maps 1h / 6h / 24h / all", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  assert.equal(cutoffForWindow("1h", now), "2026-08-30 11:00:00");
  assert.equal(cutoffForWindow("6h", now), "2026-08-30 06:00:00");
  assert.equal(cutoffForWindow("24h", now), "2026-08-29 12:00:00");
  assert.equal(cutoffForWindow("all", now), null);
});

test("emptyVault refuses without exact DELETE confirm", () => {
  wipeShelves();
  assert.throws(() => emptyVault("all", "delete"), /Type DELETE/);
  assert.throws(() => emptyVault("all", ""), /Type DELETE/);
  assert.equal(previewVaultPurge("all").total, 0);
});

test("emptyVault removes only bottles inside the time window", () => {
  wipeShelves();
  const now = new Date("2026-08-30T12:00:00.000Z");
  const fresh = sqliteUtc(new Date(now.getTime() - 30 * 60 * 1000));
  const mid = sqliteUtc(new Date(now.getTime() - 3 * 60 * 60 * 1000));
  const old = sqliteUtc(new Date(now.getTime() - 48 * 60 * 60 * 1000));

  const keepSpirit = insertSpirit("Old Rye", old);
  const dropSpirit = insertSpirit("Fresh Rye", fresh);
  insertBeer("Mid IPA", mid);
  insertBeer("Old Lager", old);
  insertWine("Fresh Blanc", fresh);
  insertWine("Ancient Rouge", old);

  assert.deepEqual(previewVaultPurge("1h", now), {
    spirits: 1,
    packaged_beer: 0,
    wines: 1,
    total: 2
  });

  const result = emptyVault("1h", PURGE_CONFIRM, now);
  assert.deepEqual(result, { spirits: 1, packaged_beer: 0, wines: 1, total: 2 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM spirits").get() as { n: number }).n, 1);
  assert.ok(db.prepare("SELECT id FROM spirits WHERE id=?").get(keepSpirit));
  assert.equal(db.prepare("SELECT id FROM spirits WHERE id=?").get(dropSpirit), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM packaged_beer").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM wines").get() as { n: number }).n, 1);

  const six = emptyVault("6h", PURGE_CONFIRM, now);
  assert.equal(six.packaged_beer, 1);
  assert.equal(six.total, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM packaged_beer").get() as { n: number }).n, 1);

  wipeShelves();
});

test("emptyVault all clears shelves and related votes/reviews", () => {
  wipeShelves();
  const spiritId = insertSpirit("Trace", sqliteUtc(new Date()));
  const beerId = insertBeer("Hazy", sqliteUtc(new Date()));
  createReview("spirits", spiritId, "Nick", "Solid pour");
  castVote("packaged_beer", beerId, "voter-alpha-1", 1);
  castDailyVote("packaged_beer", beerId, "Patron", 1);

  const result = emptyVault("all", PURGE_CONFIRM);
  assert.deepEqual(result, { spirits: 1, packaged_beer: 1, wines: 0, total: 2 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM spirits").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM packaged_beer").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM votes").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM daily_votes").get() as { n: number }).n, 0);
  wipeShelves();
});

test("emptyVault leaves taps and cocktails alone", () => {
  wipeShelves();
  const tapsBefore = (db.prepare("SELECT COUNT(*) AS n FROM taps").get() as { n: number }).n;
  const cocktailsBefore = (db.prepare("SELECT COUNT(*) AS n FROM cocktails").get() as { n: number }).n;
  insertSpirit("Doomed", sqliteUtc(new Date()));
  emptyVault("all", PURGE_CONFIRM);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM taps").get() as { n: number }).n, tapsBefore);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM cocktails").get() as { n: number }).n, cocktailsBefore);
  wipeShelves();
});
