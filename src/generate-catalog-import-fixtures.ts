#!/usr/bin/env node
/**
 * Generate minimal PA spirits/wines workbooks and Iowa CSV for runtime import verification.
 * CLI: node dist/generate-catalog-import-fixtures.js /output/dir
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeExcelMatrix } from "./ingestion/catalogs/government/excel-matrix.js";
import { PA_EXPECTED_HEADERS } from "./ingestion/catalogs/government/pa-columns.js";
import { IOWA_GOVERNMENT_HEADERS } from "./ingestion/catalogs/government/iowa-import.js";

function paRow(
  row: Record<string, unknown> & { upcs?: string[] }
): unknown[] {
  const upcs = row.upcs ?? ["", "", "", "", ""];
  let upcOrdinal = 0;
  return PA_EXPECTED_HEADERS.map((header) => {
    if (header === "UPC") return upcs[upcOrdinal++] ?? "";
    return row[header] ?? "";
  });
}

async function writePaFixture(
  rows: Array<Record<string, unknown> & { upcs?: string[] }>,
  filePath: string
): Promise<void> {
  await writeExcelMatrix([[...PA_EXPECTED_HEADERS], ...rows.map(paRow)], filePath);
}

async function main(): Promise<void> {
  const outDir = resolve(process.argv[2] ?? "test-fixtures/catalog-import");
  mkdirSync(outDir, { recursive: true });

  const spiritsPath = resolve(outDir, "pa-spirits-fixture.xlsx");
  await writePaFixture(
    [
      {
        "Division Name": "Stock Spirits",
        "Group Name": "Brandy-Cognac",
        "Class Name": "Armagnac",
        "PLCB Item": "000006481",
        "Item Description": "Marie Duffau Armagnac Napoleon",
        "PLCB SCC Item": "10008068648217",
        "Manufacturer SCC": "00008068648210",
        "Liquid Volume": "750 ml",
        "Case Pack": 12,
        "Current Regular Retail": 39.99,
        "Price Indicator": "N",
        Proof: 80,
        Vintage: "N/A",
        "Brand Name": "MARIE DUFFAU",
        "Import/Domestic": "Imported",
        Country: "France",
        Region: "",
        "Extraction Date": "2026-03-23",
        upcs: ["091882064815", "", "", "", ""]
      }
    ],
    spiritsPath
  );

  const winesPath = resolve(outDir, "pa-wines-fixture.xlsx");
  await writePaFixture(
    [
      {
        "Division Name": "Stock Wines",
        "Group Name": "Red Table",
        "Class Name": "Cabernet Sauvignon",
        "PLCB Item": "000100001",
        "Item Description": "Test Cabernet Estate",
        "PLCB SCC Item": "100100001001",
        "Manufacturer SCC": "00012345678901",
        "Liquid Volume": "750 ml",
        "Case Pack": 12,
        "Current Regular Retail": 14.99,
        "Price Indicator": "N",
        Proof: "N/A",
        Vintage: 2019,
        "Brand Name": "Test Estate",
        "Import/Domestic": "Imported",
        Country: "France",
        Region: "France - Bordeaux",
        "Extraction Date": "2026-03-23",
        upcs: ["012345678905", "", "", "", ""]
      }
    ],
    winesPath
  );

  const iowaPath = resolve(outDir, "iowa-fixture.csv");
  writeFileSync(
    iowaPath,
    `${IOWA_GOVERNMENT_HEADERS.join(",")}\n11788,"100% Agave Tequila","CASAMIGOS REPOSADO",421,"SAZERAC COMPANY  INC",750,6,1,"",80.0,"2024-01-01",080480160053,"",16.5,99,24.75,"2026-03-01"\n`,
    "utf8"
  );

  console.log(`Wrote catalog import fixtures to ${outDir}`);
  console.log(`  ${spiritsPath}`);
  console.log(`  ${winesPath}`);
  console.log(`  ${iowaPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
