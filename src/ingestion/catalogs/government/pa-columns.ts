/**
 * PA PLCB wholesale report column signature (34 columns).
 * Five identically named UPC headers are renamed by ordinal — never keyed only by name.
 */

export const PA_EXPECTED_HEADERS = [
  "Division Name",
  "Group Name",
  "Class Name",
  "PLCB Item",
  "Item Description",
  "PLCB SCC Item",
  "Manufacturer SCC",
  "Liquid Volume",
  "Case Pack",
  "Current Regular Retail",
  "Price Indicator",
  "Promotion discount",
  "Promotion discount Value",
  "Promotion Retail ",
  "Promotion Start Date",
  "Promotion End Date",
  "UPC",
  "UPC",
  "UPC",
  "UPC",
  "UPC",
  "TI",
  "HI",
  "Each Length",
  "Each Width",
  "Each Height",
  "Each Weight",
  "Proof",
  "Vintage",
  "Brand Name",
  "Import/Domestic",
  "Country",
  "Region",
  "Extraction Date"
] as const;

export type PaCanonicalField =
  | "division_name"
  | "group_name"
  | "class_name"
  | "plcb_item"
  | "item_description"
  | "plcb_scc_item"
  | "manufacturer_scc"
  | "liquid_volume"
  | "case_pack"
  | "current_regular_retail"
  | "price_indicator"
  | "promotion_discount"
  | "promotion_discount_value"
  | "promotion_retail"
  | "promotion_start_date"
  | "promotion_end_date"
  | "upc_1"
  | "upc_2"
  | "upc_3"
  | "upc_4"
  | "upc_5"
  | "ti"
  | "hi"
  | "each_length"
  | "each_width"
  | "each_height"
  | "each_weight"
  | "proof"
  | "vintage"
  | "brand_name"
  | "import_domestic"
  | "country"
  | "region"
  | "extraction_date";

const CANONICAL_BY_ORDINAL: PaCanonicalField[] = [
  "division_name",
  "group_name",
  "class_name",
  "plcb_item",
  "item_description",
  "plcb_scc_item",
  "manufacturer_scc",
  "liquid_volume",
  "case_pack",
  "current_regular_retail",
  "price_indicator",
  "promotion_discount",
  "promotion_discount_value",
  "promotion_retail",
  "promotion_start_date",
  "promotion_end_date",
  "upc_1",
  "upc_2",
  "upc_3",
  "upc_4",
  "upc_5",
  "ti",
  "hi",
  "each_length",
  "each_width",
  "each_height",
  "each_weight",
  "proof",
  "vintage",
  "brand_name",
  "import_domestic",
  "country",
  "region",
  "extraction_date"
];

export type PaRawRow = Record<PaCanonicalField, string>;

function headerEqual(actual: string, expected: string): boolean {
  // Promotion Retail has a meaningful trailing space in the source report.
  if (expected === "Promotion Retail ") {
    return actual === "Promotion Retail " || actual.replace(/\s+$/, "") === "Promotion Retail";
  }
  return actual.trim() === expected.trim() || actual === expected;
}

export function validatePaHeaders(headers: string[]): void {
  if (headers.length < PA_EXPECTED_HEADERS.length) {
    throw new Error(
      `PA workbook has ${headers.length} columns; expected ${PA_EXPECTED_HEADERS.length}`
    );
  }
  for (let i = 0; i < PA_EXPECTED_HEADERS.length; i++) {
    const actual = String(headers[i] ?? "");
    const expected = PA_EXPECTED_HEADERS[i]!;
    if (!headerEqual(actual, expected)) {
      throw new Error(
        `PA header mismatch at column ${i + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      );
    }
  }
  const upcIndexes = headers
    .map((h, i) => (String(h).trim() === "UPC" ? i : -1))
    .filter((i) => i >= 0);
  if (upcIndexes.length < 5) {
    throw new Error(`PA workbook must include five UPC columns; found ${upcIndexes.length}`);
  }
}

export function mapPaRow(headers: string[], cells: unknown[]): PaRawRow {
  const out = {} as PaRawRow;
  for (let i = 0; i < CANONICAL_BY_ORDINAL.length; i++) {
    const key = CANONICAL_BY_ORDINAL[i]!;
    const value = cells[i];
    out[key] =
      value == null || value === ""
        ? ""
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : String(value).trimEnd();
  }
  // Keep raw trailing-space semantics for promotion_retail source fidelity in payload,
  // but trimEnd already applied for storage convenience on most fields.
  if (cells[13] != null) {
    out.promotion_retail = String(cells[13]);
  }
  void headers;
  return out;
}

export function paCell(row: PaRawRow, field: PaCanonicalField): string {
  return String(row[field] ?? "").trim();
}

export function normalizePaBrand(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text || /^not\s+found$/i.test(text)) return null;
  return text;
}

export function parsePaProof(raw: string | null | undefined): {
  proof: number | null;
  flags: string[];
} {
  const text = String(raw ?? "").trim();
  if (!text || /^n\/?a$/i.test(text)) return { proof: null, flags: [] };
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return { proof: null, flags: ["proof_unparseable"] };
  const n = Number.parseFloat(match[0]!);
  if (!Number.isFinite(n) || n <= 0 || n > 200) {
    return { proof: null, flags: ["proof_out_of_range"] };
  }
  return { proof: Math.round(n * 10) / 10, flags: [] };
}

export function parsePaVintage(raw: string | null | undefined): {
  vintageYear: number | null;
  vintageStatus: string | null;
} {
  const text = String(raw ?? "").trim();
  if (!text) return { vintageYear: null, vintageStatus: null };
  if (/^non\s*-?\s*vintage$|^n\.?v\.?$|^nv$/i.test(text)) {
    return { vintageYear: null, vintageStatus: "nonvintage" };
  }
  if (/^n\/?a$/i.test(text)) return { vintageYear: null, vintageStatus: null };
  const year = text.match(/\b(19|20)\d{2}\b/);
  if (year) return { vintageYear: Number.parseInt(year[0]!, 10), vintageStatus: null };
  return { vintageYear: null, vintageStatus: text };
}

export function paSourceRowKey(extractionDate: string, plcbSccItem: string): string {
  return `${extractionDate}::${plcbSccItem}`;
}
