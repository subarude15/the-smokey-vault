#!/usr/bin/env node
/**
 * CLI: npm run catalog:import:pa-spirits -- file.xlsx
 */
import { resolve } from "node:path";
import {
  importPaSpiritsWorkbook,
  printPaImportStats
} from "./ingestion/catalogs/government/pa-import.js";

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: npm run catalog:import:pa-spirits -- /path/to/pa-spirits.xlsx");
    process.exit(1);
  }
  const stats = await importPaSpiritsWorkbook(resolve(fileArg));
  console.log(printPaImportStats(stats));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
