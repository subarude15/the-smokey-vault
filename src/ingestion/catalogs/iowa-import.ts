/**
 * Iowa Liquor Products CSV → local SQLite importer.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  normalizeCanonicalAbv,
  normalizeCanonicalProof,
  normalizeCanonicalVolumeMl
} from "../../canonical-normalize.js";
import { normalizeIowaUpc } from "./iowa-upc.js";
import {
  getIowaDbPath,
  replaceIowaProducts,
  type IowaProductRow
} from "./iowa-store.js";

export const IOWA_REQUIRED_HEADERS = [
  "item_no",
  "category_name",
  "im_desc",
  "vendor_no",
  "vendor_name",
  "bottle_volume_ml",
  "pack",
  "inner_pack",
  "age",
  "proof",
  "list_on",
  "upc",
  "scc",
  "state_bottle_cost",
  "state_case_cost",
  "state_bottle_retail",
  "report_as_of"
] as const;

export type IowaImportSummary = {
  rowsRead: number;
  rowsImported: number;
  validUpcs: number;
  rowsWithProof: number;
  rowsWithCategory: number;
  duplicateItemNumbers: number;
  invalidUpcs: number;
  dbPath: string;
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function validateIowaHeaders(headers: string[]): void {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const missing = IOWA_REQUIRED_HEADERS.filter((h) => !normalized.includes(h));
  if (missing.length) {
    throw new Error(`Iowa CSV missing required headers: ${missing.join(", ")}`);
  }
}

export function deriveAbvFromProof(proofRaw: unknown): { proof: number | null; abv: number | null } {
  const proof = normalizeCanonicalProof(proofRaw);
  if (proof == null) return { proof: null, abv: null };
  const abv = normalizeCanonicalAbv(proof / 2, { productType: "spirit" });
  return { proof, abv };
}

export function normalizeIowaVolumeMl(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return normalizeCanonicalVolumeMl(n);
}

export function rowFromIowaCsv(cells: Record<string, string>): {
  row: IowaProductRow;
  upcValid: boolean;
  upcPrecisionLost: boolean;
} {
  const upcNorm = normalizeIowaUpc(cells.upc ?? "");
  const { proof, abv } = deriveAbvFromProof(cells.proof);
  const ageRaw = String(cells.age ?? "").trim();
  const ageNum = ageRaw === "" ? null : Number.parseFloat(ageRaw);
  const age = ageNum != null && Number.isFinite(ageNum) && ageNum > 0 ? ageNum : null;

  const row: IowaProductRow = {
    item_no: String(cells.item_no ?? "").trim(),
    category_name: String(cells.category_name ?? "").trim(),
    name: String(cells.im_desc ?? "").trim(),
    vendor_no: String(cells.vendor_no ?? "").trim() || null,
    vendor_name: String(cells.vendor_name ?? "").trim() || null,
    bottle_volume_ml: normalizeIowaVolumeMl(cells.bottle_volume_ml),
    age,
    proof,
    abv,
    list_on: String(cells.list_on ?? "").trim() || null,
    report_as_of: String(cells.report_as_of ?? "").trim() || null,
    upc: upcNorm.valid ? upcNorm.upc : null,
    raw_upc: upcNorm.rawUpc || null
  };

  return {
    row,
    upcValid: upcNorm.valid,
    upcPrecisionLost: upcNorm.precisionLost
  };
}

export async function importIowaCsv(
  csvPath: string,
  options: { dbPath?: string } = {}
): Promise<IowaImportSummary> {
  const dbPath = options.dbPath ?? getIowaDbPath();
  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  let headers: string[] | null = null;
  const rows: IowaProductRow[] = [];
  let rowsRead = 0;
  let validUpcs = 0;
  let invalidUpcs = 0;
  let rowsWithProof = 0;
  let rowsWithCategory = 0;
  const itemNos = new Map<string, Set<string>>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = parseCsvLine(line).map((h) => h.trim().toLowerCase());
      validateIowaHeaders(headers);
      continue;
    }
    rowsRead++;
    const cellsRaw = parseCsvLine(line);
    const cells: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      cells[headers[i]!] = cellsRaw[i] ?? "";
    }
    const { row, upcValid } = rowFromIowaCsv(cells);
    if (!row.item_no || !row.category_name) continue;
    if (upcValid) validUpcs++;
    else if (String(cells.upc ?? "").trim()) invalidUpcs++;
    if (row.proof != null) rowsWithProof++;
    if (row.category_name) rowsWithCategory++;
    const cats = itemNos.get(row.item_no) ?? new Set<string>();
    cats.add(row.category_name);
    itemNos.set(row.item_no, cats);
    rows.push(row);
  }

  if (!headers) {
    throw new Error("Iowa CSV is empty");
  }

  const rowsImported = replaceIowaProducts(rows, dbPath);
  let duplicateItemNumbers = 0;
  for (const cats of itemNos.values()) {
    if (cats.size > 1) duplicateItemNumbers++;
  }

  return {
    rowsRead,
    rowsImported,
    validUpcs,
    rowsWithProof,
    rowsWithCategory,
    duplicateItemNumbers,
    invalidUpcs,
    dbPath
  };
}

export function formatIowaImportSummary(summary: IowaImportSummary): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return [
    `Rows read: ${fmt(summary.rowsRead)}`,
    `Rows imported: ${fmt(summary.rowsImported)}`,
    `Valid UPCs: ${fmt(summary.validUpcs)}`,
    `Rows with proof: ${fmt(summary.rowsWithProof)}`,
    `Rows with category: ${fmt(summary.rowsWithCategory)}`,
    `Duplicate item numbers: ${fmt(summary.duplicateItemNumbers)}`,
    `Invalid UPCs: ${fmt(summary.invalidUpcs)}`,
    `Database: ${summary.dbPath}`
  ].join("\n");
}
