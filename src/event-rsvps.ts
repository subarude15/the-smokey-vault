import { db } from "./db.js";
import {
  clipBody,
  clipText,
  MAX_CONTACT_INFO,
  MAX_MESSAGE_BODY,
  MAX_PATRON_NAME,
  MAX_RSVP_PARTY_SIZE,
  RSVP_SOURCES,
  RSVP_STATUSES,
  type EventRsvp,
  type EventRsvpSummary,
  type RsvpSource,
  type RsvpStatus
} from "./speakeasy-shared.js";
import { getEvent, SpeakeasyError } from "./speakeasy.js";

const RSVP_COLUMNS =
  "id, event_id, name, contact_info, status, party_size, notes, source, created_at, updated_at";

export type RsvpActor = "guest" | "keeper";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** ponytail: same civil-day rule as client/src/event-date.ts; share the helper if a third caller appears. */
function isUpcomingEventDate(raw: string, now = new Date()): boolean {
  const match = YMD_RE.exec(String(raw ?? "").trim());
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const local = new Date(year, month - 1, day, 23, 59, 59, 999);
    if (
      local.getFullYear() === year &&
      local.getMonth() === month - 1 &&
      local.getDate() === day
    ) {
      return local.getTime() >= now.getTime();
    }
  }
  const stamp = Date.parse(String(raw ?? "").trim());
  return !Number.isFinite(stamp) || stamp >= now.getTime() - 86_400_000;
}

function isRsvpStatus(value: string): value is RsvpStatus {
  return (RSVP_STATUSES as readonly string[]).includes(value);
}

function isRsvpSource(value: string): value is RsvpSource {
  return (RSVP_SOURCES as readonly string[]).includes(value);
}

export function parseRsvpStatus(value: unknown): RsvpStatus {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!isRsvpStatus(raw)) throw new SpeakeasyError("Choose Going, Maybe, or Can't make it");
  return raw;
}

export function parseRsvpSource(value: unknown, fallback: RsvpSource = "website"): RsvpSource {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!isRsvpSource(raw)) throw new SpeakeasyError("Pick a valid RSVP source");
  return raw;
}

export function parsePartySize(value: unknown, status: RsvpStatus): number {
  if (status === "declined") return 0;
  if (value === undefined || value === null || String(value).trim() === "") return 1;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_RSVP_PARTY_SIZE) {
    throw new SpeakeasyError(`Party size should be a whole number from 1 to ${MAX_RSVP_PARTY_SIZE}`);
  }
  return n;
}

export function summarizeEventRsvps(rows: EventRsvp[]): EventRsvpSummary {
  let going = 0;
  let maybe = 0;
  let declined = 0;
  let expected_guests = 0;
  for (const row of rows) {
    switch (row.status) {
      case "going":
        going += 1;
        expected_guests += row.party_size;
        break;
      case "maybe":
        maybe += 1;
        break;
      case "declined":
        declined += 1;
        break;
      default: {
        const _exhaustive: never = row.status;
        throw new Error(`Unhandled RSVP status: ${_exhaustive}`);
      }
    }
  }
  return { going, maybe, declined, expected_guests };
}

function getRsvpRow(id: number): EventRsvp | undefined {
  return db.prepare(`SELECT ${RSVP_COLUMNS} FROM event_rsvps WHERE id=?`).get(id) as EventRsvp | undefined;
}

export function listEventRsvps(eventId: number): EventRsvp[] {
  getEvent(eventId, true);
  return db.prepare(
    `SELECT ${RSVP_COLUMNS} FROM event_rsvps WHERE event_id=? ORDER BY id ASC`
  ).all(eventId) as EventRsvp[];
}

export function eventRsvpPayload(eventId: number): { rsvps: EventRsvp[]; summary: EventRsvpSummary } {
  const rsvps = listEventRsvps(eventId);
  return { rsvps, summary: summarizeEventRsvps(rsvps) };
}

function assertGuestMayRsvp(eventId: number): void {
  const event = getEvent(eventId, false);
  if (!isUpcomingEventDate(event.event_date)) {
    throw new SpeakeasyError("This event has already happened. RSVPs are closed.");
  }
}

export function createEventRsvp(
  eventId: number,
  input: Record<string, unknown>,
  actor: RsvpActor
): EventRsvp {
  if (actor === "guest") assertGuestMayRsvp(eventId);
  else getEvent(eventId, true);

  const name = clipText(input.name, MAX_PATRON_NAME);
  if (!name) throw new SpeakeasyError("Add your name");
  const status = parseRsvpStatus(input.status);
  const party_size = parsePartySize(input.party_size, status);
  const source = actor === "guest" ? "website" : parseRsvpSource(input.source);
  const result = db.prepare(
    `INSERT INTO event_rsvps(event_id, name, contact_info, status, party_size, notes, source)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    name,
    clipText(input.contact_info, MAX_CONTACT_INFO),
    status,
    party_size,
    clipBody(input.notes, MAX_MESSAGE_BODY),
    source
  );
  const created = getRsvpRow(Number(result.lastInsertRowid));
  if (!created) throw new SpeakeasyError("Could not save that RSVP");
  return created;
}

export function updateEventRsvp(
  eventId: number,
  rsvpId: number,
  input: Record<string, unknown>
): EventRsvp {
  getEvent(eventId, true);
  const existing = getRsvpRow(rsvpId);
  if (!existing || existing.event_id !== eventId) throw new SpeakeasyError("RSVP not found", 404);

  const name = input.name === undefined ? existing.name : clipText(input.name, MAX_PATRON_NAME);
  if (!name) throw new SpeakeasyError("Add a name");
  const status = input.status === undefined ? existing.status : parseRsvpStatus(input.status);
  const partyRaw = input.party_size === undefined ? existing.party_size : input.party_size;
  const party_size = parsePartySize(status === "declined" ? 0 : partyRaw, status);
  const source = input.source === undefined ? existing.source : parseRsvpSource(input.source, existing.source);
  const contact = input.contact_info === undefined
    ? existing.contact_info
    : clipText(input.contact_info, MAX_CONTACT_INFO);
  const notes = input.notes === undefined ? existing.notes : clipBody(input.notes, MAX_MESSAGE_BODY);

  db.prepare(
    `UPDATE event_rsvps
     SET name=?, contact_info=?, status=?, party_size=?, notes=?, source=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND event_id=?`
  ).run(name, contact, status, party_size, notes, source, rsvpId, eventId);

  const updated = getRsvpRow(rsvpId);
  if (!updated) throw new SpeakeasyError("RSVP not found", 404);
  return updated;
}

export function deleteEventRsvp(eventId: number, rsvpId: number): boolean {
  getEvent(eventId, true);
  return db.prepare("DELETE FROM event_rsvps WHERE id=? AND event_id=?").run(rsvpId, eventId).changes > 0;
}
