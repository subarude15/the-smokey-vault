/**
 * Event dates are YYYY-MM-DD civil days for the bar in Pennsylvania, not
 * timestamps. Compare those strings to today's date in America/New_York so
 * RSVP/upcoming checks do not follow the Docker/host timezone.
 */

export const EVENT_CALENDAR_TIMEZONE = "America/New_York";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Valid YYYY-MM-DD, or null. Uses UTC only to reject impossible calendar days. */
export function eventCalendarYmd(raw: string): string | null {
  const match = YMD_RE.exec(String(raw ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Today's YYYY-MM-DD in `timeZone`. Independent of `process.env.TZ`. */
export function civilDateInTimeZone(now: Date, timeZone = EVENT_CALENDAR_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
}

/**
 * True while the event's calendar date has not ended in the vault timezone.
 * Unparseable dates stay open (same as the previous Date.parse fallback).
 */
export function isUpcomingEventDate(
  raw: string,
  now = new Date(),
  timeZone = EVENT_CALENDAR_TIMEZONE
): boolean {
  const event = eventCalendarYmd(raw);
  if (!event) return true;
  return event >= civilDateInTimeZone(now, timeZone);
}
