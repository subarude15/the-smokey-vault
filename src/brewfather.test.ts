import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  fetchBrewfatherBatches,
  mapBrewfatherBatch,
  mapBrewfatherStatus,
  syncBrews,
  upsertMappedBrew,
  type BrewfatherBatch
} from "./brewfather.js";
import { db } from "./db.js";
import { parseList } from "./catalog.js";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/brewfather-batch.json"), "utf8")
) as BrewfatherBatch;

test("Brewfather statuses map onto Brewery Lab", () => {
  assert.equal(mapBrewfatherStatus("Planning"), "Planned");
  assert.equal(mapBrewfatherStatus("Brewing"), "Fermenting");
  assert.equal(mapBrewfatherStatus("Fermenting"), "Fermenting");
  assert.equal(mapBrewfatherStatus("Conditioning"), "Conditioning");
  assert.equal(mapBrewfatherStatus("Completed"), "Ready to Keg");
  assert.equal(mapBrewfatherStatus("Archived"), "Archived");
});

test("fixture batch maps name, style, gravities, hops, and photo", () => {
  const mapped = mapBrewfatherBatch(fixture);
  assert.equal(mapped.brewfather_id, "bf-test-citra-smash");
  assert.equal(mapped.batch_name, "Citra Smash");
  assert.equal(mapped.style, "American Pale Ale");
  assert.equal(mapped.maker, "Nick");
  assert.equal(mapped.status, "Fermenting");
  assert.equal(mapped.brew_date, "2024-04-21");
  assert.equal(mapped.target_og, 1.05);
  assert.equal(mapped.target_fg, 1.01);
  assert.equal(mapped.measured_og, 1.052);
  assert.equal(mapped.measured_fg, null);
  assert.deepEqual(mapped.hops, ["Citra", "Citra", "Mosaic"]);
  assert.equal(mapped.image_url, "https://brewfather.app/images/example.jpg");
  assert.equal(mapped.count, undefined);
});

test("upsert by brewfather_id updates instead of duplicating", () => {
  db.prepare("DELETE FROM brews WHERE brewfather_id=?").run(fixture._id);
  const first = upsertMappedBrew(mapBrewfatherBatch(fixture));
  const second = upsertMappedBrew(mapBrewfatherBatch({
    ...fixture,
    status: "Completed",
    measuredFg: 1.012
  }));
  assert.equal(first.action, "inserted");
  assert.equal(second.action, "updated");
  assert.equal(first.id, second.id);
  const rows = db.prepare("SELECT * FROM brews WHERE brewfather_id=?").all(fixture._id) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "Ready to Keg");
  assert.equal(rows[0].measured_fg, 1.012);
  assert.deepEqual(parseList(rows[0].hops), ["Citra", "Mosaic"]);
  db.prepare("DELETE FROM brews WHERE brewfather_id=?").run(fixture._id);
});

test("local-only brews without a brewfather_id stay put during upsert", () => {
  const local = db.prepare("INSERT INTO brews(batch_name,status) VALUES(?,?)").run("House Pale", "Planned");
  upsertMappedBrew(mapBrewfatherBatch(fixture));
  const kept = db.prepare("SELECT * FROM brews WHERE id=?").get(local.lastInsertRowid) as Record<string, unknown>;
  assert.equal(kept.batch_name, "House Pale");
  assert.equal(kept.status, "Planned");
  assert.equal(kept.brewfather_id, null);
  db.prepare("DELETE FROM brews WHERE id=?").run(local.lastInsertRowid);
  db.prepare("DELETE FROM brews WHERE brewfather_id=?").run(fixture._id);
});

test("fetchBrewfatherBatches paginates until a short page", async () => {
  const previousUser = process.env.BREWFATHER_USER_ID;
  const previousKey = process.env.BREWFATHER_API_KEY;
  process.env.BREWFATHER_USER_ID = "user";
  process.env.BREWFATHER_API_KEY = "key";
  let calls = 0;
  const fetcher = async (url: string) => {
    calls += 1;
    const startAfter = new URL(url).searchParams.get("start_after");
    const page = startAfter
      ? [{ _id: "b2", name: "Second" }]
      : Array.from({ length: 50 }, (_, index) => ({ _id: `a${index}`, name: `Batch ${index}` }));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => page
    };
  };
  try {
    const batches = await fetchBrewfatherBatches(fetcher);
    assert.equal(batches.length, 51);
    assert.equal(calls, 2);
  } finally {
    process.env.BREWFATHER_USER_ID = previousUser;
    process.env.BREWFATHER_API_KEY = previousKey;
  }
});

test("syncBrews upserts fixture batches and does not invent packaged beer", async () => {
  db.prepare("DELETE FROM brews WHERE brewfather_id=?").run(fixture._id);
  const packagedBefore = (db.prepare("SELECT COUNT(*) AS n FROM packaged_beer").get() as { n: number }).n;
  const previousUser = process.env.BREWFATHER_USER_ID;
  const previousKey = process.env.BREWFATHER_API_KEY;
  process.env.BREWFATHER_USER_ID = "user";
  process.env.BREWFATHER_API_KEY = "key";
  const fetcher = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => [{ ...fixture, img_url: "" }]
  });
  try {
    const result = await syncBrews({ force: true, fetcher });
    assert.equal(result.skipped, false);
    assert.equal(result.inserted + result.updated, 1);
    const brew = db.prepare("SELECT * FROM brews WHERE brewfather_id=?").get(fixture._id) as Record<string, unknown>;
    assert.equal(brew.batch_name, "Citra Smash");
    const packagedAfter = (db.prepare("SELECT COUNT(*) AS n FROM packaged_beer").get() as { n: number }).n;
    assert.equal(packagedAfter, packagedBefore);
  } finally {
    process.env.BREWFATHER_USER_ID = previousUser;
    process.env.BREWFATHER_API_KEY = previousKey;
    db.prepare("DELETE FROM brews WHERE brewfather_id=?").run(fixture._id);
  }
});
