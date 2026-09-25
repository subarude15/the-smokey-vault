/** Public brew-sheet PDF helpers. No browser code, so the client can import this. */
export const BREW_SHEET_PDF_ERROR = "Couldn’t generate this brew sheet PDF.";

const SAFE_PDF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.pdf$/;

/** ASCII attachment name. Strips header-breaking characters. */
export function brewSheetPdfFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n"]/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleaned || "Brew"}-Brew-Sheet.pdf`;
}

export function pdfFilenameFromDisposition(header: string | null, fallback: string): string {
  const match = /filename="([^"]*)"/.exec(header ?? "");
  const name = match?.[1] ?? "";
  return SAFE_PDF_NAME.test(name) ? name : fallback;
}
