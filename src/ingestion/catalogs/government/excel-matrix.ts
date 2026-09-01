/**
 * ExcelJS helpers for PA workbook import/tests.
 * Preserves display text (including leading zeros and trailing header spaces).
 */
import ExcelJS from "exceljs";

/** Convert one ExcelJS cell to a string, matching SheetJS `raw: false` display text. */
export function excelCellToString(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null || value === "") return "";

  if (typeof value === "string") {
    // Preserve trailing whitespace (e.g. "Promotion Retail ").
    return value;
  }

  if (typeof value === "number") {
    // Prefer formatted text when Excel applies custom formats (leading zeros, etc.).
    const text = cell.text;
    if (typeof text === "string" && text.length > 0) return text;
    return String(value);
  }

  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  if (value instanceof Date) {
    const text = cell.text;
    if (typeof text === "string" && text.length > 0) return text;
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "object") {
    if ("richText" in value && Array.isArray((value as ExcelJS.CellRichTextValue).richText)) {
      return (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
    }
    if ("text" in value && (value as ExcelJS.CellHyperlinkValue).text != null) {
      return String((value as ExcelJS.CellHyperlinkValue).text);
    }
    if ("result" in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      if (result == null || result === "") return "";
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      return String(result);
    }
    if ("error" in value) return "";
    if ("sharedFormula" in value) {
      const result = (value as ExcelJS.CellSharedFormulaValue).result;
      if (result == null || result === "") return "";
      return String(result);
    }
  }

  const fallback = cell.text;
  if (typeof fallback === "string") return fallback;
  return String(value);
}

/**
 * Read the first worksheet as a dense row/column string matrix (1-based Excel → 0-based arrays).
 */
export async function readExcelMatrix(fileBuf: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs typings accept Buffer via ArrayBuffer-like load targets
  await workbook.xlsx.load(fileBuf as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("PA workbook has no sheets");

  const rowCount = sheet.rowCount;
  if (!rowCount) return [];

  let colCount = Math.max(sheet.columnCount || 0, sheet.getRow(1).cellCount || 0, 34);
  // Ensure we cover the widest used row (sparse trailing columns).
  for (let r = 1; r <= rowCount; r++) {
    colCount = Math.max(colCount, sheet.getRow(r).cellCount || 0);
  }

  const matrix: string[][] = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      cells.push(excelCellToString(row.getCell(c)));
    }
    matrix.push(cells);
  }
  return matrix;
}

/** Write an AOA matrix to .xlsx via ExcelJS (values stored as strings when provided as strings). */
export async function writeExcelMatrix(
  rows: unknown[][],
  filePath: string,
  sheetName = "Sheet1"
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (let r = 0; r < rows.length; r++) {
    const rowValues = rows[r] ?? [];
    const excelRow = sheet.getRow(r + 1);
    for (let c = 0; c < rowValues.length; c++) {
      const raw = rowValues[c];
      if (raw == null || raw === "") {
        excelRow.getCell(c + 1).value = null;
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        excelRow.getCell(c + 1).value = raw;
      } else if (typeof raw === "boolean") {
        excelRow.getCell(c + 1).value = raw;
      } else {
        // Strings keep leading zeros and trailing header spaces.
        excelRow.getCell(c + 1).value = String(raw);
      }
    }
    excelRow.commit();
  }
  await workbook.xlsx.writeFile(filePath);
}
