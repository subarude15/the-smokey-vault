/**
 * Iowa Liquor Products UPC normalization.
 *
 * CSV UPCs arrive as plain digit strings (often with a leading zero) or as
 * scientific-notation strings / floats from spreadsheet exporters. Never treat
 * a UPC as an IEEE float — expand scientific notation only when the mantissa
 * carries enough significant digits; otherwise mark the UPC unusable.
 */

export type IowaUpcNormalization = {
  /** Original cell text / stringified parser value (diagnostics). */
  rawUpc: string;
  /** Canonical digit string for barcode lookup, or null when unusable. */
  upc: string | null;
  /** True when a usable digit UPC was produced. */
  valid: boolean;
  /** True when scientific notation looked truncated / precision-lost. */
  precisionLost: boolean;
};

const SCI_RE = /^[+-]?(\d+)(?:\.(\d+))?e([+-]?\d+)$/i;

/** Minimum significant digits accepted from scientific notation for a retail UPC. */
const MIN_SCI_SIGNIFICANT_DIGITS = 11;

/**
 * Expand a scientific-notation string into an exact digit string using only
 * digits present in the mantissa. Returns null when expansion would invent
 * significant digits (precision already lost in the source).
 */
export function expandScientificUpc(raw: string): { digits: string | null; precisionLost: boolean } {
  const text = String(raw ?? "").trim();
  const match = text.match(SCI_RE);
  if (!match) return { digits: null, precisionLost: false };

  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  const mantissaDigits = `${whole}${frac}`;
  const fracLen = frac.length;
  const exponent = Number.parseInt(match[3] ?? "0", 10);
  if (!Number.isFinite(exponent) || !mantissaDigits) {
    return { digits: null, precisionLost: true };
  }

  const significant = mantissaDigits.replace(/^0+/, "") || "0";
  if (significant.length < MIN_SCI_SIGNIFICANT_DIGITS) {
    return { digits: null, precisionLost: true };
  }

  // value = mantissaDigits * 10^(exponent - fracLen)
  const shift = exponent - fracLen;
  if (shift >= 0) {
    return { digits: `${mantissaDigits}${"0".repeat(shift)}`, precisionLost: false };
  }

  const cut = -shift;
  if (cut >= mantissaDigits.length) {
    return { digits: null, precisionLost: true };
  }
  const head = mantissaDigits.slice(0, mantissaDigits.length - cut);
  const tail = mantissaDigits.slice(mantissaDigits.length - cut);
  if (/[1-9]/.test(tail)) {
    return { digits: null, precisionLost: true };
  }
  return { digits: head, precisionLost: false };
}

function digitsOnly(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

function formatNumberPreservingSci(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
    return String(n);
  }
  return n.toExponential().replace(/e\+?/, "e");
}

function finalizeDigits(
  rawUpc: string,
  digits: string,
  precisionLost: boolean
): IowaUpcNormalization {
  if (digits.length < 8 || digits.length > 14) {
    return { rawUpc, upc: null, valid: false, precisionLost };
  }
  return { rawUpc, upc: digits, valid: true, precisionLost: false };
}

/**
 * Normalize an Iowa CSV UPC cell to the digit string the barcode system uses.
 * Preserves leading zeros for plain digit strings. Rejects precision-lost sci forms.
 */
export function normalizeIowaUpc(raw: unknown): IowaUpcNormalization {
  const rawUpc =
    raw == null
      ? ""
      : typeof raw === "number" && Number.isFinite(raw)
        ? formatNumberPreservingSci(raw)
        : String(raw).trim();

  if (!rawUpc) {
    return { rawUpc: "", upc: null, valid: false, precisionLost: false };
  }

  const compact = rawUpc.replace(/\s+/g, "");
  if (SCI_RE.test(compact)) {
    const expanded = expandScientificUpc(compact);
    if (expanded.precisionLost || !expanded.digits) {
      return { rawUpc, upc: null, valid: false, precisionLost: true };
    }
    return finalizeDigits(rawUpc, expanded.digits, false);
  }

  const digits = digitsOnly(rawUpc);
  if (!digits) {
    return { rawUpc, upc: null, valid: false, precisionLost: false };
  }
  return finalizeDigits(rawUpc, digits, false);
}
