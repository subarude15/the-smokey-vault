import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { parseImportCsv, parseImportText, readImportPayload } from "./import_batch.js";
import {
  commitReadyImportRows,
  importQueueCounts,
  listImportQueue,
  lookupToQueueFields,
  queueLookupResult,
  seedImportQueue
} from "./import_queue.js";
import type { LookupResult } from "./lookup-shared.js";

function wipeQueue() {
  db.prepare("DELETE FROM import_queue").run();
}

test("CSV ingest reads a headered file and a bare UPC list", () => {
  const headered = parseImportCsv("upc,table,name\n080686000891,spirits,Buffalo Trace\n");
  assert.equal(headered[0]?.upc, "080686000891");
  assert.equal(headered[0]?.name, "Buffalo Trace");
  const bare = parseImportCsv("080686000891\n012345678905\n");
  assert.equal(bare.length, 2);
  assert.equal(bare[0]?.upc, "080686000891");
});

test("JSON and CSV payloads fold into the same reader", () => {
  assert.equal(readImportPayload({ csv: "upc\n080686000891" }).length, 1);
  assert.equal(parseImportText('{"items":[{"upc":"080686000891"}]}').length, 1);
});

test("a named overnight hit with no photo is Ready", () => {
  const result: LookupResult = {
    source: "fwgs",
    upc: "080686000891",
    table: "spirits",
    kind: "spirits",
    product: { upc: "080686000891", name: "Buffalo Trace", image_url: "" }
  };
  const fields = lookupToQueueFields(result);
  assert.equal(fields.status, "ready");
  assert.equal(fields.reason, null);
});

test("a catalog miss stays in the queue as needs review", () => {
  const fields = lookupToQueueFields({
    source: "not_found",
    upc: "012345678905",
    product: { upc: "012345678905", name: "" },
    reason: "no_catalog",
    message: "No catalog match."
  });
  assert.equal(fields.status, "needs_review");
  assert.equal(fields.reason, "no_catalog");
});

test("commit writes only Ready rows and leaves misses queued", async () => {
  wipeQueue();
  try {
    seedImportQueue([
      { upc: "080686000891", name: "Buffalo Trace", brand: "Sazerac", category: "Bourbon", abv: 45 },
      { upc: "012345678905" }
    ]);
    const before = listImportQueue();
    assert.ok(before.some((row) => row.status === "ready"));
    assert.ok(before.some((row) => row.status === "pending"));
    const outcome = await commitReadyImportRows();
    assert.equal(outcome.imported, 1);
    assert.equal(outcome.items[0]?.name, "Buffalo Trace");
    const remaining = listImportQueue();
    assert.equal(remaining.some((row) => row.upc === "080686000891" && row.status === "ready"), false);
    assert.ok(remaining.some((row) => row.status === "pending" || row.status === "needs_review"));
    const spirit = db.prepare("SELECT name FROM spirits WHERE upc=?").get("080686000891") as { name?: string } | undefined;
    assert.equal(spirit?.name, "Buffalo Trace");
  } finally {
    db.prepare("DELETE FROM spirits WHERE upc=?").run("080686000891");
    db.prepare("DELETE FROM barcode_cache WHERE upc=?").run("080686000891");
    wipeQueue();
  }
});

test("queue counts split Ready from Needs review", () => {
  wipeQueue();
  try {
    queueLookupResult({
      source: "fwgs",
      upc: "080244009365",
      product: { name: "Eagle Rare", upc: "080244009365" }
    });
    queueLookupResult({
      source: "not_found",
      upc: "000111222333",
      product: { name: "", upc: "000111222333" },
      reason: "cola_gap"
    });
    const counts = importQueueCounts();
    assert.equal(counts.ready, 1);
    assert.equal(counts.needs_review, 1);
  } finally {
    wipeQueue();
  }
});
