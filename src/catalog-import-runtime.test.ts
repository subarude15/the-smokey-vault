/**
 * Verifies compiled catalog import CLIs (node dist/...) work without tsx or src/.
 * Run after `npm run build`: npm run test:catalog-import-runtime
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { resetGovernmentDbConnection } from "./ingestion/catalogs/government/schema.js";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");

const IMPORTERS = [
  {
    name: "pa-spirits",
    dist: "dist/catalog-import-pa-spirits.js",
    fixture: "pa-spirits-fixture.xlsx",
    dataset: "plcb_spirits"
  },
  {
    name: "pa-wines",
    dist: "dist/catalog-import-pa-wines.js",
    fixture: "pa-wines-fixture.xlsx",
    dataset: "plcb_wines"
  },
  {
    name: "iowa",
    dist: "dist/catalog-import-iowa.js",
    fixture: "iowa-fixture.csv",
    dataset: "iowa"
  }
] as const;

function runNode(args: string[], env: NodeJS.ProcessEnv): spawnSync.SpawnSyncReturns<string> {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8"
  });
}

function assertDistBuilt(): void {
  for (const importer of IMPORTERS) {
    assert.ok(
      existsSync(join(root, importer.dist)),
      `Missing ${importer.dist}; run npm run build first`
    );
  }
  assert.ok(
    existsSync(join(root, "dist/generate-catalog-import-fixtures.js")),
    "Missing dist/generate-catalog-import-fixtures.js; run npm run build first"
  );
}

test("exceljs resolves from production node_modules (PA imports)", () => {
  const exceljsPath = require.resolve("exceljs/package.json", { paths: [root] });
  assert.ok(existsSync(exceljsPath));
});

test("compiled catalog importers run via node dist and share one DB", { skip: process.env.CATALOG_IMPORT_RUNTIME !== "1" }, () => {
  assertDistBuilt();

  const workDir = mkdtempSync(join(tmpdir(), "catalog-import-runtime-"));
  const fixturesDir = join(workDir, "fixtures");
  const dbPath = join(workDir, "government-catalog.sqlite");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    GOVERNMENT_CATALOG_DB_PATH: dbPath
  };

  try {
    const gen = runNode(["dist/generate-catalog-import-fixtures.js", fixturesDir], env);
    assert.equal(gen.status, 0, gen.stderr || gen.stdout);

    for (const importer of IMPORTERS) {
      const fixturePath = join(fixturesDir, importer.fixture);
      assert.ok(existsSync(fixturePath), fixturePath);

      const result = runNode([importer.dist, fixturePath], env);
      assert.equal(
        result.status,
        0,
        `${importer.name} importer failed:\n${result.stderr}\n${result.stdout}`
      );
      assert.match(result.stdout, /rows imported|Rows imported|imported/i);
    }

    resetGovernmentDbConnection();
    assert.ok(existsSync(dbPath));
    assert.ok(statSync(dbPath).size > 0);

    const db = new Database(dbPath, { readonly: true });
    try {
      const datasets = db
        .prepare(
          `SELECT dataset, COUNT(*) AS sources
           FROM catalog_sources
           WHERE is_current = 1
           GROUP BY dataset
           ORDER BY dataset`
        )
        .all() as Array<{ dataset: string; sources: number }>;

      for (const importer of IMPORTERS) {
        const row = datasets.find((d) => d.dataset === importer.dataset);
        assert.ok(row, `missing current source for ${importer.dataset}`);
        assert.ok(row.sources >= 1);
      }

      const products = db
        .prepare(`SELECT COUNT(*) AS c FROM catalog_products WHERE is_current = 1`)
        .get() as { c: number };
      assert.ok(products.c >= 3);
    } finally {
      db.close();
    }
  } finally {
    resetGovernmentDbConnection();
    rmSync(workDir, { recursive: true, force: true });
  }
});
