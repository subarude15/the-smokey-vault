/**
 * Lightweight Keeper build/version identifier (PR145).
 *
 * The identifier is derived from build/deployment metadata injected at image build
 * time — no committed milestone constant to remember to bump each PR:
 *   - BUILD_DATE : ISO date the image was built (CI: `date -u +%Y-%m-%d`)
 *   - BUILD_PR   : the PR/version number this build includes (CI: parsed from the
 *                  merge commit message, e.g. "… (#145)")
 *   - GIT_SHA    : the commit the image was built from (CI: `github.sha`)
 *
 * For local/dev runs where none of these are set, it falls back deterministically
 * to today's date with a ".dev" marker so the card is never blank or misleading.
 * Only these three build values are read — no secrets or unrelated env are exposed.
 */

export type BuildInfo = {
  /** Compact identifier, e.g. "090826.145" (MMDDYY.PR) or "090826.dev" locally. */
  build: string;
  /** ISO date used (YYYY-MM-DD). */
  date: string;
  /** Human date, e.g. "Sep 8, 2026". */
  dateLabel: string;
  /** e.g. "Sep 8, 2026 · through PR145 · abc1234" (PR/SHA parts included when present). */
  subtitle: string;
  /** PR/version number when available, else null. */
  pr: number | null;
  /** Short commit SHA when available, else null. */
  sha: string | null;
  /** Whether the metadata came from a real build (CI/build args) or a dev fallback. */
  stamped: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseIsoDate(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function isoToday(now: Date): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

/** MMDDYY from an ISO date — e.g. "2026-09-08" → "090826". */
export function buildDateStamp(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return "000000";
  return `${pad2(parsed.month)}${pad2(parsed.day)}${String(parsed.year).slice(-2)}`;
}

/** Human date label — e.g. "Sep 8, 2026". Falls back to the raw string if unparseable. */
export function buildDateLabel(date: string): string {
  const parsed = parseIsoDate(date);
  if (!parsed) return date;
  return `${MONTHS[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

/**
 * Resolve the effective build info from injected build metadata, with a safe
 * local/dev fallback. `now` is injectable for deterministic tests.
 */
export function getBuildInfo(env: Record<string, string | undefined> = {}, now: Date = new Date()): BuildInfo {
  const rawPr = (env.BUILD_PR ?? "").trim();
  const prNum = Number(rawPr);
  const pr = rawPr && Number.isFinite(prNum) && prNum > 0 ? Math.floor(prNum) : null;

  const rawDate = (env.BUILD_DATE ?? "").trim();
  const stampedDate = parseIsoDate(rawDate) ? rawDate : null;
  const date = stampedDate ?? isoToday(now);

  const sha = ((env.GIT_SHA ?? env.GITHUB_SHA ?? env.SOURCE_COMMIT ?? "").trim().slice(0, 7)) || null;

  const stamped = Boolean(stampedDate || pr !== null || sha);
  const dateLabel = buildDateLabel(date);
  const build = `${buildDateStamp(date)}.${pr !== null ? pr : "dev"}`;

  const parts = [dateLabel];
  parts.push(pr !== null ? `through PR${pr}` : "local dev build");
  if (sha) parts.push(sha);

  return {
    build,
    date,
    dateLabel,
    subtitle: parts.join(" · "),
    pr,
    sha,
    stamped
  };
}
