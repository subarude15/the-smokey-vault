/**
 * Lightweight build/version identifier (PR145).
 *
 * `BUILD_PR` and `BUILD_DATE` are the single source of truth, updated once per
 * milestone PR (never in the UI). Everything the Keeper sees — the build number,
 * the human date, and the "through PRxxx" subtitle — is derived from them. Values
 * can also be injected at build/startup via env (`BUILD_PR`, `BUILD_DATE`,
 * `GIT_SHA`) so CI can stamp them without editing code. The commit SHA is optional
 * and simply omitted when unavailable.
 */

/** The milestone PR this build includes through. Bump once per product PR. */
export const BUILD_PR = 145;

/** ISO date (YYYY-MM-DD) for this build. Bump alongside BUILD_PR. */
export const BUILD_DATE = "2026-09-08";

export type BuildInfo = {
  /** Compact identifier, e.g. "090826.145" (MMDDYY.PR). */
  build: string;
  /** Raw ISO date. */
  date: string;
  /** Human date, e.g. "Sep 8, 2026". */
  dateLabel: string;
  /** e.g. "Sep 8, 2026 · through PR145". */
  subtitle: string;
  pr: number;
  /** Short commit SHA when available, else null. */
  sha: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseIsoDate(date: string): { year: number; month: number; day: number } | null {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** MMDDYY.PR — e.g. buildNumber("2026-09-08", 145) === "090826.145". */
export function buildNumber(date: string, pr: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return `000000.${pr}`;
  return `${pad2(parsed.month)}${pad2(parsed.day)}${String(parsed.year).slice(-2)}.${pr}`;
}

/** Human date label — e.g. "Sep 8, 2026". Falls back to the raw string if unparseable. */
export function buildDateLabel(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  return `${MONTHS[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

/**
 * Resolve the effective build info, preferring env overrides over the committed
 * constants so CI can stamp values without code edits.
 */
export function getBuildInfo(env: Record<string, string | undefined> = {}): BuildInfo {
  const envPr = Number((env.BUILD_PR ?? "").trim());
  const pr = Number.isFinite(envPr) && envPr > 0 ? Math.floor(envPr) : BUILD_PR;
  const date = (env.BUILD_DATE ?? "").trim() || BUILD_DATE;
  const sha = ((env.GIT_SHA ?? env.SOURCE_COMMIT ?? "").trim().slice(0, 7)) || null;
  const dateLabel = buildDateLabel(date);
  return {
    build: buildNumber(date, pr),
    date,
    dateLabel,
    subtitle: `${dateLabel} · through PR${pr}`,
    pr,
    sha
  };
}
