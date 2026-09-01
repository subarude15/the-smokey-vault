/**
 * Government catalog health / diagnostics + lookup log bounds.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCanonicalAbv, normalizeCanonicalProof } from "../../canonical-normalize.js";
import {
  getGovernmentCatalogHealth,
  getGovernmentDbPath,
  openGovernmentDb,
  resetGovernmentDbConnection,
  searchGovernmentByBarcode,
  tryGovernmentStage
} from "./government/index.js";

function tempDb(): string {
  return path.join(
    os.tmpdir(),
    `gov-health-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
}

test("government catalog health warns when DB is missing", () => {
  const dbPath = path.join(os.tmpdir(), `gov-missing-${Date.now()}.sqlite`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  const health = getGovernmentCatalogHealth({ dbPath });
  assert.equal(health.exists, false);
  assert.equal(health.lookupOperational, false);
  assert.equal(health.path, path.resolve(dbPath));
  assert.ok(health.warning);
  assert.equal(health.currentByDataset.plcb_spirits.currentProducts, 0);
  assert.equal(health.currentByDataset.plcb_wines.currentProducts, 0);
  assert.equal(health.currentByDataset.iowa.currentProducts, 0);
  assert.equal(fs.existsSync(dbPath), false, "health probe must not create the DB");
});

test("government catalog health warns when DB exists with zero current products", () => {
  const dbPath = tempDb();
  resetGovernmentDbConnection();
  openGovernmentDb(dbPath);
  resetGovernmentDbConnection();
  const health = getGovernmentCatalogHealth({ dbPath });
  assert.equal(health.exists, true);
  assert.equal(health.lookupOperational, true);
  assert.equal(health.totals.products, 0);
  assert.ok(health.warning);
  assert.match(String(health.warning), /zero current products/i);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

test("government lookup logs hit/miss/ambiguous without catalog payloads", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = {
    info(fields: Record<string, unknown>) {
      lines.push(fields);
    }
  };

  const miss = await tryGovernmentStage({
    upc: "000000000000",
    dbPath: tempDb(),
    logger
  });
  assert.equal(miss.lookup.status, "miss");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.event, "government_catalog_lookup");
  assert.equal(lines[0]?.status, "miss");
  assert.equal(lines[0]?.upc, "000000000000");
  assert.equal(lines[0]?.source, null);
  assert.ok(!JSON.stringify(lines[0]).includes("raw_payload"));
  assert.ok(!JSON.stringify(lines[0]).includes("name"));

  // Direct search path remains unchanged.
  const direct = searchGovernmentByBarcode("000000000000", { dbPath: tempDb() });
  assert.equal(direct.status, "miss");
});

test("ABV/proof value 0 normalizes to null for inventory/UI", () => {
  assert.equal(normalizeCanonicalAbv(0), null);
  assert.equal(normalizeCanonicalAbv("0"), null);
  assert.equal(normalizeCanonicalAbv("0%"), null);
  assert.equal(normalizeCanonicalProof(0), null);
  assert.equal(normalizeCanonicalProof("0"), null);
  assert.equal(normalizeCanonicalAbv(40), 40);
  assert.equal(normalizeCanonicalProof(80), 80);
});

test("getGovernmentDbPath resolves env override", () => {
  const prev = process.env.GOVERNMENT_CATALOG_DB_PATH;
  process.env.GOVERNMENT_CATALOG_DB_PATH = "/tmp/custom-gov-catalog.sqlite";
  try {
    assert.equal(getGovernmentDbPath(), "/tmp/custom-gov-catalog.sqlite");
  } finally {
    if (prev === undefined) delete process.env.GOVERNMENT_CATALOG_DB_PATH;
    else process.env.GOVERNMENT_CATALOG_DB_PATH = prev;
  }
});
