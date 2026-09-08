/** Presentation helpers for cocktail `method` text (PR137). Never invents steps. */

export type CocktailInstructions =
  | { kind: "empty" }
  | { kind: "method"; label: string }
  | { kind: "prose"; text: string }
  | { kind: "steps"; steps: string[] };

function stripStepNumber(text: string): string {
  return text.replace(/^\d+[\.)]\s+/, "").trim();
}

function splitNumberedSteps(text: string): string[] | null {
  const parts = text
    .split(/(?=\d+[\.)]\s+)/)
    .map((part) => stripStepNumber(part.trim()))
    .filter(Boolean);
  // Require at least two numbered markers in the original string.
  const markers = text.match(/\d+[\.)]\s+/g);
  if (!markers || markers.length < 2 || parts.length < 2) return null;
  return parts;
}

function splitNewlineSteps(text: string): string[] | null {
  if (!/[\n\r]/.test(text)) return null;
  const lines = text.split(/\r?\n/).map((line) => stripStepNumber(line.trim())).filter(Boolean);
  return lines.length >= 2 ? lines : null;
}

/** Short technique labels (Shake / Stir / …) stay method chips; richer text does not. */
export function isCocktailMethodLabel(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 48 || /[\n\r]/.test(value)) return false;
  if (/\d+[\.)]\s+/.test(value)) return false;
  // Multiple sentences → not a single method label.
  if (/[.!?]+\s+\S/.test(value)) return false;
  return true;
}

/** Card/header summary: only keep compact method labels. */
export function cocktailMethodSummary(method: unknown): string {
  const text = String(method ?? "").trim();
  if (!text) return "";
  return isCocktailMethodLabel(text) ? text : "";
}

export function parseCocktailInstructions(method: unknown): CocktailInstructions {
  const text = String(method ?? "").trim();
  if (!text) return { kind: "empty" };

  const numbered = splitNumberedSteps(text);
  if (numbered) return { kind: "steps", steps: numbered };

  const newlines = splitNewlineSteps(text);
  if (newlines) return { kind: "steps", steps: newlines };

  if (isCocktailMethodLabel(text)) return { kind: "method", label: text };

  return { kind: "prose", text };
}
