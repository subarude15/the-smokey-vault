/**
 * Government catalog health / diagnostics + lookup log bounds + path strategy.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeCanonicalAbv, normalizeCanonicalProof } from "../../canonical-normalize.js";
import {
  DEFAULT_GOVERNMENT_DB_PATH,
  getGovernmentCatalogHealth,
  getGovernmentDataDir,
  getGovernmentDbPath,
  openGovernmentDb,
  PRODUCTION_GOVERNMENT_DATA_DIR,
  probeDirectoryWritable,
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

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    prev[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
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
  assert.equal(health.dataDir, path.dirname(path.resolve(dbPath)));
  assert.equal(health.fileSizeBytes, null);
  assert.equal(typeof health.dataDirWritable, "boolean");
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
  assert.ok(health.fileSizeBytes != null && health.fileSizeBytes >= 0);
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

test("getGovernmentDbPath honors GOVERNMENT_CATALOG_DB_PATH for importers and runtime", () => {
  withEnv({ GOVERNMENT_CATALOG_DB_PATH: "/tmp/custom-gov-catalog.sqlite" }, () => {
    assert.equal(getGovernmentDbPath(), "/tmp/custom-gov-catalog.sqlite");
  });
});

test("production default resolves under /app/data without env override", () => {
  withEnv(
    {
      NODE_ENV: "production",
      GOVERNMENT_CATALOG_DB_PATH: undefined,
      GOVERNMENT_CATALOG_DATA_DIR: undefined
    },
    () => {
      assert.equal(getGovernmentDataDir(), PRODUCTION_GOVERNMENT_DATA_DIR);
      assert.equal(getGovernmentDbPath(), "/app/data/government-catalog.sqlite");
    }
  );
});

test("local default stays under ./data and matches DEFAULT_GOVERNMENT_DB_PATH", () => {
  withEnv(
    {
      NODE_ENV: "development",
      GOVERNMENT_CATALOG_DB_PATH: undefined,
      GOVERNMENT_CATALOG_DATA_DIR: undefined
    },
    () => {
      assert.equal(getGovernmentDbPath(), DEFAULT_GOVERNMENT_DB_PATH);
      assert.ok(String(getGovernmentDbPath()).includes("government-catalog.sqlite"));
    }
  );
});

test("GOVERNMENT_CATALOG_DATA_DIR is honored when DB path is unset", () => {
  withEnv(
    {
      NODE_ENV: "production",
      GOVERNMENT_CATALOG_DB_PATH: undefined,
      GOVERNMENT_CATALOG_DATA_DIR: "/custom/data-dir"
    },
    () => {
      assert.equal(getGovernmentDataDir(), "/custom/data-dir");
      assert.equal(getGovernmentDbPath(), "/custom/data-dir/government-catalog.sqlite");
    }
  );
});

test("probeDirectoryWritable does not create missing directories", () => {
  const missing = path.join(os.tmpdir(), `gov-dir-missing-${Date.now()}`);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(probeDirectoryWritable(missing), false);
  assert.equal(fs.existsSync(missing), false);
});
