#!/usr/bin/env node
/**
 * CLI: npm run import:iowa -- /path/to/iowa-products.csv
 */
import { resolve } from "node:path";
import {
  formatIowaImportSummary,
  importIowaCsv
} from "./ingestion/catalogs/iowa-import.js";

async function main() {
  const csvArg = process.argv[2];
  if (!csvArg) {
    console.error("Usage: npm run import:iowa -- /path/to/iowa-products.csv");
    process.exit(1);
  }
  const csvPath = resolve(csvArg);
  const summary = await importIowaCsv(csvPath);
  console.log(formatIowaImportSummary(summary));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
