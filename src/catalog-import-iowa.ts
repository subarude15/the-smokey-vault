#!/usr/bin/env node
/**
 * CLI: npm run catalog:import:iowa -- file.csv  (production: node dist/catalog-import-iowa.js)
 */
import { resolve } from "node:path";
import {
  importIowaGovernmentCsv,
  printIowaGovernmentImportStats
} from "./ingestion/catalogs/government/iowa-import.js";

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: npm run catalog:import:iowa -- /path/to/iowa-products.csv");
    process.exit(1);
  }
  const stats = await importIowaGovernmentCsv(resolve(fileArg));
  console.log(printIowaGovernmentImportStats(stats));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
