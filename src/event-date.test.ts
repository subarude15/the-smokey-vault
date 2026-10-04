/**
 * Event calendar dates must stay on the civil day the Keeper picked.
 * YYYY-MM-DD must never be parsed as UTC midnight (off-by-one in US zones).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eventDateInputValue,
  eventDateLabel,
  isUpcomingEventDate,
  parseEventCalendarDate
} from "../client/src/event-date.ts";

test("parseEventCalendarDate keeps December 5 as local December 5", () => {
  const local = parseEventCalendarDate("2026-12-05");
  assert.ok(local);
  assert.equal(local.getFullYear(), 2026);
  assert.equal(local.getMonth(), 11);
  assert.equal(local.getDate(), 5);
});

test("eventDateLabel does not UTC-shift a date-only string", () => {
  const label = eventDateLabel("2026-12-05");
  assert.match(label, /December/);
  assert.match(label, /5/);
  assert.doesNotMatch(label, /\b4\b/);
  assert.doesNotMatch(label, /\b6\b/);
});

test("eventDateInputValue preserves YYYY-MM-DD for the date picker", () => {
  assert.equal(eventDateInputValue("2026-12-05"), "2026-12-05");
  assert.equal(eventDateInputValue("2026-12-05T00:00:00.000Z"), "2026-12-05");
});

test("isUpcomingEventDate uses America/New_York civil dates, not the host timezone", () => {
  // 11:30pm EDT on 2026-07-04 is already 2026-07-05 03:30 UTC.
  const lateEasternSummer = new Date("2026-07-05T03:30:00.000Z");
  assert.equal(isUpcomingEventDate("2026-07-04", lateEasternSummer), true);
  assert.equal(isUpcomingEventDate("2026-07-03", lateEasternSummer), false);
  assert.equal(isUpcomingEventDate("2026-07-05", lateEasternSummer), true);

  // Midnight Eastern (EDT) is 04:00 UTC — the previous calendar day is over.
  const easternMidnightSummer = new Date("2026-07-05T04:00:00.000Z");
  assert.equal(isUpcomingEventDate("2026-07-04", easternMidnightSummer), false);
  assert.equal(isUpcomingEventDate("2026-07-05", easternMidnightSummer), true);

  // 10:30pm EST on 2026-12-05 is 2026-12-06 03:30 UTC.
  const lateEasternWinter = new Date("2026-12-06T03:30:00.000Z");
  assert.equal(isUpcomingEventDate("2026-12-05", lateEasternWinter), true);
  assert.equal(isUpcomingEventDate("2026-12-05", new Date("2026-12-06T05:00:00.000Z")), false);
});
