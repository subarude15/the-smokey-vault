#!/usr/bin/env node
/**
 * CLI: npm run catalog:import:pa-wines -- file.xlsx  (production: node dist/catalog-import-pa-wines.js)
 */
import { resolve } from "node:path";
import {
  importPaWinesWorkbook,
  printPaImportStats
} from "./ingestion/catalogs/government/pa-import.js";

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: npm run catalog:import:pa-wines -- /path/to/pa-wines.xlsx");
    process.exit(1);
  }
  const stats = await importPaWinesWorkbook(resolve(fileArg));
  console.log(printPaImportStats(stats));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
