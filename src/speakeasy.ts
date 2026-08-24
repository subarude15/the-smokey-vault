import { db, getSetting } from "./db.js";
import { itemExists } from "./reviews.js";
import {
  clipBody, clipText, LEADERBOARD_SIZE, MAX_CONTACT_INFO, MAX_MESSAGE_BODY, MAX_PATRON_NAME,
  MAX_PATRON_NICKNAME, MESSAGE_ALERT_DELAY_MS, vaultDayDate,
  type DailyVoteResult, type EventSubscriber, type GuestMessage, type HouseEvent, type MerchItem, type Patron
} from "./speakeasy-shared.js";

export class SpeakeasyError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const PATRON_COLUMNS = "id, name, nickname, visit_count, notes, created_at, updated_at";

/* ---------------------------------- Patrons --------------------------------- */

export function listPatrons(limit?: number): Patron[] {
  const sql = `SELECT ${PATRON_COLUMNS} FROM patrons ORDER BY visit_count DESC, updated_at ASC${limit ? " LIMIT ?" : ""}`;
  return (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as Patron[];
}

export function listLeaderboard(): Patron[] {
  return listPatrons(LEADERBOARD_SIZE);
}

export function getPatron(id: number): Patron | undefined {
  return db.prepare(`SELECT ${PATRON_COLUMNS} FROM patrons WHERE id=?`).get(id) as Patron | undefined;
}

export function createPatron(input: { name?: unknown; nickname?: unknown; notes?: unknown; visit_count?: unknown }): Patron {
  const name = clipText(input.name, MAX_PATRON_NAME);
  if (!name) throw new SpeakeasyError("Add the patron's name");
  const existing = db.prepare("SELECT id FROM patrons WHERE name=? COLLATE NOCASE").get(name) as { id: number } | undefined;
  if (existing) throw new SpeakeasyError(`${name} is already on the leaderboard`, 409);
  const visits = Number(input.visit_count);
  const result = db.prepare(
    "INSERT INTO patrons(name, nickname, visit_count, notes) VALUES(?, ?, ?, ?)"
  ).run(
    name,
    clipText(input.nickname, MAX_PATRON_NICKNAME),
    Number.isFinite(visits) && visits > 0 ? Math.floor(visits) : 1,
    clipBody(input.notes, MAX_MESSAGE_BODY)
  );
  return getPatron(Number(result.lastInsertRowid))!;
}

export function updatePatron(id: number, input: { nickname?: unknown; notes?: unknown; visit_count?: unknown }): Patron {
  const patron = getPatron(id);
  if (!patron) throw new SpeakeasyError("Patron not found", 404);
  const visits = Number(input.visit_count);
  db.prepare(
    "UPDATE patrons SET nickname=?, notes=?, visit_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).run(
    input.nickname === undefined ? patron.nickname : clipText(input.nickname, MAX_PATRON_NICKNAME),
    input.notes === undefined ? patron.notes : clipBody(input.notes, MAX_MESSAGE_BODY),
    input.visit_count !== undefined && Number.isFinite(visits) ? Math.max(0, Math.floor(visits)) : patron.visit_count,
    id
  );
  return getPatron(id)!;
}

export function adjustPatronVisits(id: number, delta: number): Patron {
  const patron = getPatron(id);
  if (!patron) throw new SpeakeasyError("Patron not found", 404);
  const next = Math.max(0, patron.visit_count + delta);
  db.prepare("UPDATE patrons SET visit_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(next, id);
  return getPatron(id)!;
}

export function deletePatron(id: number): boolean {
  return db.prepare("DELETE FROM patrons WHERE id=?").run(id).changes > 0;
}

/* ------------------------- Daily identity-locked votes ---------------------- */

function dailyTally(table: string, itemId: number, voteDate: string) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down_count
    FROM daily_votes WHERE target_table=? AND item_id=? AND vote_date=?
  `).get(table, itemId, voteDate) as { up_count: number | null; down_count: number | null };
  const up = Number(row?.up_count ?? 0);
  const down = Number(row?.down_count ?? 0);
  return { up, down, net: up - down };
}

export function castDailyVote(
  table: string,
  itemId: number,
  patronName: unknown,
  value: unknown,
  now = new Date()
): DailyVoteResult {
  const name = clipText(patronName, MAX_PATRON_NAME);
  if (!name) throw new SpeakeasyError("Tell us who you are before you vote");
  const score = Number(value);
  if (score !== 1 && score !== -1) throw new SpeakeasyError("A vote must be a thumbs up or thumbs down");
  if (!itemExists(table, itemId)) throw new SpeakeasyError("Bottle not found", 404);

  const voteDate = vaultDayDate(now);
  const already = db.prepare(
    "SELECT id FROM daily_votes WHERE target_table=? AND item_id=? AND patron_name=? COLLATE NOCASE AND vote_date=?"
  ).get(table, itemId, name, voteDate);
  if (already) {
    return {
      ok: false,
      already_voted: true,
      vote_date: voteDate,
      notice: `Thanks ${name} — you already rated this one tonight. Come back after 4 AM for another vote.`,
      ...dailyTally(table, itemId, voteDate)
    };
  }
  db.prepare(
    "INSERT INTO daily_votes(target_table, item_id, patron_name, vote_date, value) VALUES(?, ?, ?, ?, ?)"
  ).run(table, itemId, name, voteDate, score);
  return {
    ok: true,
    already_voted: false,
    vote_date: voteDate,
    notice: score === 1 ? "Poured and approved. Thanks for the vote!" : "Noted — we will keep looking for a better pour.",
    ...dailyTally(table, itemId, voteDate)
  };
}

export function dailyVoteTallies(table: string, now = new Date()) {
  const voteDate = vaultDayDate(now);
  const rows = db.prepare(`
    SELECT item_id,
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down_count
    FROM daily_votes WHERE target_table=? AND vote_date=? GROUP BY item_id
  `).all(table, voteDate) as Array<{ item_id: number; up_count: number; down_count: number }>;
  return Object.fromEntries(rows.map((row) => [
    row.item_id,
    { up: Number(row.up_count), down: Number(row.down_count), net: Number(row.up_count) - Number(row.down_count) }
  ]));
}

export function deleteDailyVotesForItem(table: string, itemId: number) {
  db.prepare("DELETE FROM daily_votes WHERE target_table=? AND item_id=?").run(table, itemId);
}

/* --------------------------------- Messages --------------------------------- */

const MESSAGE_COLUMNS = "id, sender_name, contact_info, body, is_read, discord_notified, created_at";

export function createMessage(input: { sender_name?: unknown; contact_info?: unknown; body?: unknown }): GuestMessage {
  const sender = clipText(input.sender_name, MAX_PATRON_NAME);
  const contact = clipText(input.contact_info, MAX_CONTACT_INFO);
  const body = clipBody(input.body, MAX_MESSAGE_BODY);
  if (!sender) throw new SpeakeasyError("Add your name so we know who is asking");
  if (!contact) throw new SpeakeasyError("Add a phone number or email so we can reply");
  if (!body) throw new SpeakeasyError("Write a short message");
  const result = db.prepare(
    "INSERT INTO messages(sender_name, contact_info, body) VALUES(?, ?, ?)"
  ).run(sender, contact, body);
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id=?`).get(result.lastInsertRowid) as GuestMessage;
}

export function listMessages() {
  const messages = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages ORDER BY created_at DESC, id DESC`).all() as GuestMessage[];
  return { messages, unread: messages.filter((message) => !message.is_read).length, total: messages.length };
}

export function unreadMessageCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM messages WHERE is_read=0").get() as { total: number };
  return Number(row?.total ?? 0);
}

export function markMessageRead(id: number, read = true): GuestMessage {
  const result = db.prepare("UPDATE messages SET is_read=? WHERE id=?").run(read ? 1 : 0, id);
  if (!result.changes) throw new SpeakeasyError("Message not found", 404);
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id=?`).get(id) as GuestMessage;
}

export function deleteMessage(id: number): boolean {
  return db.prepare("DELETE FROM messages WHERE id=?").run(id).changes > 0;
}

/** Unread messages that have sat unanswered past the alert delay and were never announced. */
export function pendingDiscordAlerts(now = Date.now()): GuestMessage[] {
  const cutoff = new Date(now - MESSAGE_ALERT_DELAY_MS).toISOString().replace("T", " ").slice(0, 19);
  return db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE is_read=0 AND discord_notified=0 AND created_at <= ? ORDER BY id ASC`
  ).all(cutoff) as GuestMessage[];
}

export function markDiscordNotified(id: number) {
  db.prepare("UPDATE messages SET discord_notified=1 WHERE id=?").run(id);
}

export function discordWebhookUrl(): string {
  return (process.env.DISCORD_WEBHOOK_URL?.trim() || getSetting("discord_webhook_url") || "").trim();
}

/* ---------------------------------- Events ---------------------------------- */

const EVENT_COLUMNS = "id, title, event_date, description, image_url, is_published, created_at";

export function listEvents(includeUnpublished = false): HouseEvent[] {
  const where = includeUnpublished ? "" : " WHERE is_published=1";
  return db.prepare(`SELECT ${EVENT_COLUMNS} FROM events${where} ORDER BY event_date ASC, id ASC`).all() as HouseEvent[];
}

export function createEvent(input: Record<string, unknown>): HouseEvent {
  const title = clipText(input.title, 120);
  const eventDate = clipText(input.event_date, 40);
  if (!title) throw new SpeakeasyError("Give the event a title");
  if (!eventDate) throw new SpeakeasyError("Pick a date for the event");
  const result = db.prepare(
    "INSERT INTO events(title, event_date, description, image_url, is_published) VALUES(?, ?, ?, ?, ?)"
  ).run(
    title, eventDate,
    clipBody(input.description, MAX_MESSAGE_BODY),
    clipText(input.image_url, 500),
    input.is_published === undefined || Number(input.is_published) === 1 ? 1 : 0
  );
  return db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id=?`).get(result.lastInsertRowid) as HouseEvent;
}

export function updateEvent(id: number, input: Record<string, unknown>): HouseEvent {
  const existing = db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id=?`).get(id) as HouseEvent | undefined;
  if (!existing) throw new SpeakeasyError("Event not found", 404);
  db.prepare("UPDATE events SET title=?, event_date=?, description=?, image_url=?, is_published=? WHERE id=?").run(
    input.title === undefined ? existing.title : clipText(input.title, 120) || existing.title,
    input.event_date === undefined ? existing.event_date : clipText(input.event_date, 40) || existing.event_date,
    input.description === undefined ? existing.description : clipBody(input.description, MAX_MESSAGE_BODY),
    input.image_url === undefined ? existing.image_url : clipText(input.image_url, 500),
    input.is_published === undefined ? existing.is_published : Number(input.is_published) === 1 ? 1 : 0,
    id
  );
  return db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id=?`).get(id) as HouseEvent;
}

export function deleteEvent(id: number): boolean {
  return db.prepare("DELETE FROM events WHERE id=?").run(id).changes > 0;
}

/* ------------------------------ Event subscribers --------------------------- */

const SUBSCRIBER_COLUMNS = "id, name, contact_info, notes, created_at";

export function listEventSubscribers(): EventSubscriber[] {
  return db.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM event_subscribers ORDER BY id DESC`).all() as EventSubscriber[];
}

export function createEventSubscriber(input: Record<string, unknown>): EventSubscriber {
  const name = clipText(input.name, MAX_PATRON_NAME);
  const contact = clipText(input.contact_info, MAX_CONTACT_INFO);
  if (!name) throw new SpeakeasyError("Add your name");
  if (!contact) throw new SpeakeasyError("Add a phone number or email for party invites");
  const result = db.prepare(
    "INSERT INTO event_subscribers(name, contact_info, notes) VALUES(?, ?, ?)"
  ).run(name, contact, clipBody(input.notes, MAX_MESSAGE_BODY));
  return db.prepare(`SELECT ${SUBSCRIBER_COLUMNS} FROM event_subscribers WHERE id=?`).get(result.lastInsertRowid) as EventSubscriber;
}

export function deleteEventSubscriber(id: number): boolean {
  return db.prepare("DELETE FROM event_subscribers WHERE id=?").run(id).changes > 0;
}

/* ----------------------------------- Merch ---------------------------------- */

const MERCH_COLUMNS = "id, name, description, suggested_donation, image_url, is_available, created_at";

export function listMerch(includeUnavailable = false): MerchItem[] {
  const where = includeUnavailable ? "" : " WHERE is_available=1";
  return db.prepare(`SELECT ${MERCH_COLUMNS} FROM merch_items${where} ORDER BY id DESC`).all() as MerchItem[];
}

export function createMerch(input: Record<string, unknown>): MerchItem {
  const name = clipText(input.name, 120);
  if (!name) throw new SpeakeasyError("Give the item a name");
  const result = db.prepare(
    "INSERT INTO merch_items(name, description, suggested_donation, image_url, is_available) VALUES(?, ?, ?, ?, ?)"
  ).run(
    name,
    clipBody(input.description, MAX_MESSAGE_BODY),
    clipText(input.suggested_donation, 40),
    clipText(input.image_url, 500),
    input.is_available === undefined || Number(input.is_available) === 1 ? 1 : 0
  );
  return db.prepare(`SELECT ${MERCH_COLUMNS} FROM merch_items WHERE id=?`).get(result.lastInsertRowid) as MerchItem;
}

export function updateMerch(id: number, input: Record<string, unknown>): MerchItem {
  const existing = db.prepare(`SELECT ${MERCH_COLUMNS} FROM merch_items WHERE id=?`).get(id) as MerchItem | undefined;
  if (!existing) throw new SpeakeasyError("Merch item not found", 404);
  db.prepare("UPDATE merch_items SET name=?, description=?, suggested_donation=?, image_url=?, is_available=? WHERE id=?").run(
    input.name === undefined ? existing.name : clipText(input.name, 120) || existing.name,
    input.description === undefined ? existing.description : clipBody(input.description, MAX_MESSAGE_BODY),
    input.suggested_donation === undefined ? existing.suggested_donation : clipText(input.suggested_donation, 40),
    input.image_url === undefined ? existing.image_url : clipText(input.image_url, 500),
    input.is_available === undefined ? existing.is_available : Number(input.is_available) === 1 ? 1 : 0,
    id
  );
  return db.prepare(`SELECT ${MERCH_COLUMNS} FROM merch_items WHERE id=?`).get(id) as MerchItem;
}

export function deleteMerch(id: number): boolean {
  return db.prepare("DELETE FROM merch_items WHERE id=?").run(id).changes > 0;
}
