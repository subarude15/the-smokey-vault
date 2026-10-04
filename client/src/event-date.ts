/**
 * Calendar-date helpers for house events.
 *
 * Event dates are stored as YYYY-MM-DD (from `<input type="date">`). Parsing that
 * form with `Date.parse` / `new Date("YYYY-MM-DD")` treats it as UTC midnight, which
 * shifts the civil day in US timezones (and can confuse native date pickers).
 * Display labels still use Y-M-D parts (not Date.parse). Upcoming / RSVP-open
 * checks use America/New_York civil dates, not the host timezone.
 */

export { civilDateInTimeZone, EVENT_CALENDAR_TIMEZONE, isUpcomingEventDate } from "../../src/event-calendar";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

export function parseEventCalendarDate(raw: string): Date | null {
  const trimmed = String(raw ?? "").trim();
  const match = YMD_RE.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const local = new Date(year, month - 1, day);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day
  ) {
    return null;
  }
  return local;
}

export function eventDateLabel(raw: string): string {
  const local = parseEventCalendarDate(raw);
  if (local) {
    return local.toLocaleDateString(undefined, {
      weekday: "short",
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  }
  const stamp = Date.parse(String(raw ?? "").trim());
  if (!Number.isFinite(stamp)) return String(raw ?? "");
  return new Date(stamp).toLocaleDateString(undefined, {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

/** Normalize stored event_date values to YYYY-MM-DD for date inputs. */
export function eventDateInputValue(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const match = YMD_RE.exec(trimmed);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return trimmed.slice(0, 10);
}
