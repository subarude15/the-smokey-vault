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

test("isUpcomingEventDate uses the local end of the event day", () => {
  const morning = new Date(2026, 11, 5, 9, 0, 0, 0);
  const afterMidnight = new Date(2026, 11, 6, 0, 0, 1, 0);
  assert.equal(isUpcomingEventDate("2026-12-05", morning), true);
  assert.equal(isUpcomingEventDate("2026-12-05", afterMidnight), false);
});
