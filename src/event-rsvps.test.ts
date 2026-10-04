/**
 * Per-event RSVPs — guest privacy, Keeper CRUD, summary math, cascade cleanup.
 * Invite-list (`event_subscribers`) stays independent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OutboundMail } from "./mail.js";
import type { EventRsvp } from "./speakeasy-shared.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const { createEvent, createEventSubscriber, deleteEvent, listEventSubscribers } = await import("./speakeasy.js");
const { createEventRsvp, eventRsvpPayload, summarizeEventRsvps } = await import("./event-rsvps.js");
const { setGuestMessageMailTransportForTests } = await import("./message-notification.js");
const { civilDateInTimeZone, isUpcomingEventDate } = await import("./event-calendar.js");
const { buildRsvpsCsv, formatRsvpSummary } = await import("../client/src/event-rsvps.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FUTURE = "2026-12-31";
const PAST = "2020-01-15";

function cleanup() {
  db.prepare("DELETE FROM event_rsvps").run();
  db.prepare("DELETE FROM event_subscribers").run();
  db.prepare("DELETE FROM events").run();
}

function publishedEvent(title = "Winter Bash") {
  return createEvent({ title, event_date: FUTURE, description: "Bring a bottle", is_published: 1 });
}

after(() => {
  setGuestMessageMailTransportForTests(undefined);
});

test("guest can RSVP to a published event", async () => {
  cleanup();
  const event = publishedEvent();
  const res = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/rsvps`,
    payload: { name: "Dana", contact_info: "dana@example.com", status: "going", party_size: 2, notes: "GF", source: "facebook" }
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { ok?: boolean; id?: number };
  assert.equal(body.ok, true);
  assert.ok(typeof body.id === "number" && body.id > 0);
  assert.equal("contact_info" in body, false);
  const { rsvps } = eventRsvpPayload(event.id);
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].name, "Dana");
  assert.equal(rsvps[0].status, "going");
  assert.equal(rsvps[0].party_size, 2);
  assert.equal(rsvps[0].source, "website");
  assert.equal(rsvps[0].notes, "GF");
});

test("guest cannot RSVP to an unpublished event", async () => {
  cleanup();
  const draft = createEvent({ title: "Secret", event_date: FUTURE, is_published: 0 });
  const res = await app.inject({
    method: "POST",
    url: `/api/events/${draft.id}/rsvps`,
    payload: { name: "Dana", status: "going" }
  });
  assert.equal(res.statusCode, 404);
  assert.equal(eventRsvpPayload(draft.id).rsvps.length, 0);
});

test("invalid RSVP status is rejected", async () => {
  cleanup();
  const event = publishedEvent();
  const res = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/rsvps`,
    payload: { name: "Dana", status: "excited" }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /Going, Maybe, or Can't make it/i);
});

test("declined RSVP stores and counts party size as 0", async () => {
  cleanup();
  const event = publishedEvent();
  const res = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/rsvps`,
    payload: { name: "Pat", status: "declined", party_size: 4 }
  });
  assert.equal(res.statusCode, 201);
  const row = eventRsvpPayload(event.id).rsvps[0];
  assert.equal(row.status, "declined");
  assert.equal(row.party_size, 0);
  assert.equal(eventRsvpPayload(event.id).summary.expected_guests, 0);
  assert.equal(eventRsvpPayload(event.id).summary.declined, 1);
});

test("guest cannot list RSVPs or see another guest's contact", async () => {
  cleanup();
  const event = publishedEvent();
  createEventRsvp(event.id, { name: "Hidden", contact_info: "secret@example.com", status: "going" }, "keeper");
  const list = await app.inject({ method: "GET", url: `/api/events/${event.id}/rsvps` });
  assert.equal(list.statusCode, 401);
  assert.doesNotMatch(list.body, /secret@example\.com/i);
  const create = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/rsvps`,
    payload: { name: "Other", status: "maybe" }
  });
  assert.doesNotMatch(create.body, /secret@example\.com/i);
});

test("Keeper can list RSVPs and add a Facebook response", async () => {
  cleanup();
  const event = publishedEvent();
  const token = createTestAdminToken();
  const created = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/rsvps`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Nick's cousin",
      contact_info: "610-555-0100",
      status: "going",
      party_size: 3,
      source: "facebook",
      notes: "From the group post"
    }
  });
  assert.equal(created.statusCode, 201);
  const row = created.json() as EventRsvp;
  assert.equal(row.source, "facebook");
  assert.equal(row.party_size, 3);

  const list = await app.inject({
    method: "GET",
    url: `/api/events/${event.id}/rsvps`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(list.statusCode, 200);
  const payload = list.json() as { rsvps: EventRsvp[]; summary: { going: number; expected_guests: number } };
  assert.equal(payload.rsvps.length, 1);
  assert.equal(payload.rsvps[0].contact_info, "610-555-0100");
  assert.equal(payload.summary.going, 1);
  assert.equal(payload.summary.expected_guests, 3);
});

test("Keeper can edit and delete an RSVP", async () => {
  cleanup();
  const event = publishedEvent();
  const token = createTestAdminToken();
  const created = createEventRsvp(event.id, {
    name: "Alex",
    status: "maybe",
    party_size: 1,
    source: "text"
  }, "keeper");

  const updated = await app.inject({
    method: "PUT",
    url: `/api/events/${event.id}/rsvps/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: "going", party_size: 2, source: "phone" }
  });
  assert.equal(updated.statusCode, 200);
  const body = updated.json() as EventRsvp;
  assert.equal(body.status, "going");
  assert.equal(body.party_size, 2);
  assert.equal(body.source, "phone");
  assert.equal(body.name, "Alex");

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/events/${event.id}/rsvps/${created.id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(eventRsvpPayload(event.id).rsvps.length, 0);
});

test("summary counts going responses and expected guests from going party sizes only", () => {
  const rows = [
    { status: "going", party_size: 4 },
    { status: "going", party_size: 12 },
    { status: "maybe", party_size: 8 },
    { status: "declined", party_size: 0 }
  ] as EventRsvp[];
  const summary = summarizeEventRsvps(rows);
  assert.deepEqual(summary, { going: 2, maybe: 1, declined: 1, expected_guests: 16 });
  assert.equal(formatRsvpSummary(summary), "2 Going · 1 Maybe · 1 Declined · 16 expected guests");
});

test("RSVP records stay isolated by event", async () => {
  cleanup();
  const bash = publishedEvent("Bash");
  const tasting = publishedEvent("Tasting");
  createEventRsvp(bash.id, { name: "Only Bash", status: "going", party_size: 2 }, "keeper");
  createEventRsvp(tasting.id, { name: "Only Tasting", status: "maybe" }, "keeper");
  assert.deepEqual(eventRsvpPayload(bash.id).rsvps.map((row) => row.name), ["Only Bash"]);
  assert.deepEqual(eventRsvpPayload(tasting.id).rsvps.map((row) => row.name), ["Only Tasting"]);
});

function shiftYmd(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(utc.getUTCDate()).padStart(2, "0")}`;
}

/** Models a UTC container treating YYYY-MM-DD as ending at 23:59:59.999 UTC. */
function utcContainerWouldClose(ymd: string, now: Date): boolean {
  const [year, month, day] = ymd.split("-").map(Number);
  return now.getTime() > Date.UTC(year, month - 1, day, 23, 59, 59, 999);
}

test("guest RSVP stays open through the Eastern calendar day even when UTC would have closed it", () => {
  cleanup();
  const lateEasternSummer = new Date("2026-07-05T03:30:00.000Z");
  assert.equal(utcContainerWouldClose("2026-07-04", lateEasternSummer), true);
  assert.equal(isUpcomingEventDate("2026-07-04", lateEasternSummer), true);

  const event = createEvent({ title: "Fireworks", event_date: "2026-07-04", is_published: 1 });
  const rsvp = createEventRsvp(
    event.id,
    { name: "Late", status: "going" },
    "guest",
    lateEasternSummer
  );
  assert.equal(rsvp.name, "Late");

  const easternMidnight = new Date("2026-07-05T04:00:00.000Z");
  assert.throws(
    () => createEventRsvp(event.id, { name: "After midnight", status: "going" }, "guest", easternMidnight),
    (err: unknown) => err instanceof Error && /already happened/i.test(err.message)
  );

  const lateEasternWinter = new Date("2026-12-06T03:30:00.000Z");
  assert.equal(utcContainerWouldClose("2026-12-05", lateEasternWinter), true);
  const winter = createEvent({ title: "Winter", event_date: "2026-12-05", is_published: 1 });
  assert.equal(
    createEventRsvp(winter.id, { name: "Still going", status: "maybe" }, "guest", lateEasternWinter).status,
    "maybe"
  );
});

test("guest RSVP day boundary follows America/New_York, not the process timezone", async () => {
  cleanup();
  const today = civilDateInTimeZone(new Date());
  const yesterday = shiftYmd(today, -1);
  const tomorrow = shiftYmd(today, 1);

  const todayEvent = createEvent({ title: "Tonight", event_date: today, is_published: 1 });
  const yesterdayEvent = createEvent({ title: "Last night", event_date: yesterday, is_published: 1 });
  const tomorrowEvent = createEvent({ title: "Tomorrow", event_date: tomorrow, is_published: 1 });

  const todayRes = await app.inject({
    method: "POST",
    url: `/api/events/${todayEvent.id}/rsvps`,
    payload: { name: "Today Guest", status: "going" }
  });
  assert.equal(todayRes.statusCode, 201);

  const yesterdayRes = await app.inject({
    method: "POST",
    url: `/api/events/${yesterdayEvent.id}/rsvps`,
    payload: { name: "Too Late", status: "going" }
  });
  assert.equal(yesterdayRes.statusCode, 400);
  assert.match(yesterdayRes.json().error, /already happened/i);
  assert.equal(eventRsvpPayload(yesterdayEvent.id).rsvps.length, 0);

  const tomorrowRes = await app.inject({
    method: "POST",
    url: `/api/events/${tomorrowEvent.id}/rsvps`,
    payload: { name: "Early Bird", status: "maybe" }
  });
  assert.equal(tomorrowRes.statusCode, 201);
});

test("guest cannot RSVP to a past event; Keeper can still view history", async () => {
  cleanup();
  const event = createEvent({ title: "Last year", event_date: PAST, is_published: 1 });
  createEventRsvp(event.id, { name: "Archive", status: "going", party_size: 2, source: "phone" }, "keeper");
  const guest = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/rsvps`,
    payload: { name: "Late", status: "going" }
  });
  assert.equal(guest.statusCode, 400);
  assert.match(guest.json().error, /already happened/i);
  const token = createTestAdminToken();
  const list = await app.inject({
    method: "GET",
    url: `/api/events/${event.id}/rsvps`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().rsvps.length, 1);
});

test("deleting an event cascades its RSVPs", () => {
  cleanup();
  const event = publishedEvent();
  createEventRsvp(event.id, { name: "Gone", status: "going" }, "keeper");
  assert.equal(deleteEvent(event.id), true);
  const leftover = db.prepare("SELECT COUNT(*) AS n FROM event_rsvps").get() as { n: number };
  assert.equal(leftover.n, 0);
});

test("website guest RSVP emails owners; mail failure still saves; Keeper add does not email", async () => {
  cleanup();
  const sent: OutboundMail[] = [];
  setGuestMessageMailTransportForTests({
    async send(mail) {
      sent.push(mail);
    }
  });
  const previous = process.env.MESSAGE_NOTIFICATION_EMAILS;
  process.env.MESSAGE_NOTIFICATION_EMAILS = "josh@example.com";
  try {
    const event = publishedEvent("Patio Night");
    const guest = await app.inject({
      method: "POST",
      url: `/api/events/${event.id}/rsvps`,
      payload: { name: "Sam", contact_info: "sam@example.com", status: "going", party_size: 2, notes: "Nuts" }
    });
    assert.equal(guest.statusCode, 201);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.subject ?? "", /Sam/);
    assert.match(sent[0]?.text ?? "", /Patio Night/);
    assert.match(sent[0]?.text ?? "", /Going/);
    assert.match(sent[0]?.text ?? "", /Party size: 2/);
    assert.match(sent[0]?.text ?? "", /sam@example.com/);
    assert.match(sent[0]?.text ?? "", /Nuts/);

    sent.length = 0;
    setGuestMessageMailTransportForTests({
      async send() {
        throw new Error("SMTP down");
      }
    });
    const still = await app.inject({
      method: "POST",
      url: `/api/events/${event.id}/rsvps`,
      payload: { name: "Lee", status: "maybe" }
    });
    assert.equal(still.statusCode, 201);
    assert.equal(eventRsvpPayload(event.id).rsvps.length, 2);

    sent.length = 0;
    setGuestMessageMailTransportForTests({
      async send(mail) {
        sent.push(mail);
      }
    });
    const token = createTestAdminToken();
    const keeper = await app.inject({
      method: "POST",
      url: `/api/events/${event.id}/rsvps`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Facebook pal", status: "going", source: "facebook" }
    });
    assert.equal(keeper.statusCode, 201);
    assert.equal(sent.length, 0);
  } finally {
    if (previous === undefined) delete process.env.MESSAGE_NOTIFICATION_EMAILS;
    else process.env.MESSAGE_NOTIFICATION_EMAILS = previous;
    setGuestMessageMailTransportForTests(undefined);
  }
});

test("existing event_subscribers invite list still works", async () => {
  cleanup();
  const signup = await app.inject({
    method: "POST",
    url: "/api/event-subscribers",
    payload: { name: "Patio Guest", contact_info: "guest@example.com", notes: "Plus one" }
  });
  assert.equal(signup.statusCode, 201);
  assert.equal(listEventSubscribers().length, 1);
  const guestList = await app.inject({ method: "GET", url: "/api/event-subscribers" });
  assert.equal(guestList.statusCode, 401);
  createEventSubscriber({ name: "Kept", contact_info: "kept@example.com" });
  const token = createTestAdminToken();
  const keeperList = await app.inject({
    method: "GET",
    url: "/api/event-subscribers",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(keeperList.statusCode, 200);
  assert.equal((keeperList.json() as unknown[]).length, 2);
});

test("RSVP CSV reuses formula-safe escaping and includes useful columns", () => {
  const csv = buildRsvpsCsv("Winter Bash", [
    {
      id: 1,
      event_id: 9,
      name: "=SUM(1)",
      contact_info: "+123",
      status: "going",
      party_size: 2,
      notes: "Bring ice",
      source: "facebook",
      created_at: "2026-10-04 12:00:00",
      updated_at: "2026-10-04 12:00:00"
    }
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "Event,Name,Status,Party Size,Contact,Source,Notes,Created,Updated");
  assert.equal(lines[1], "Winter Bash,'=SUM(1),Going,2,'+123,Facebook,Bring ice,2026-10-04 12:00:00,2026-10-04 12:00:00");
});

test("Events UI wires per-event RSVP without replacing the invite list", () => {
  const eventsPage = readFileSync(join(root, "client/src/EventsPage.tsx"), "utf8");
  const form = readFileSync(join(root, "client/src/EventRsvpForm.tsx"), "utf8");
  const keeper = readFileSync(join(root, "client/src/EventRsvpKeeper.tsx"), "utf8");
  const subscribers = readFileSync(join(root, "client/src/EventSubscriberList.tsx"), "utf8");
  const server = readFileSync(join(root, "src/server.ts"), "utf8");
  assert.match(eventsPage, /EventRsvpForm/);
  assert.match(eventsPage, /EventRsvpKeeper/);
  assert.match(eventsPage, /EventSubscriberList/);
  assert.match(eventsPage, /Get the invite/);
  assert.match(form, /Are you coming\?/);
  assert.match(keeper, /Export CSV/);
  assert.match(keeper, /facebook/);
  assert.match(subscribers, /not RSVPs for a specific event/);
  assert.match(server, /\/api\/events\/:id\/rsvps/);
  assert.match(server, /notifyOwnersOfWebsiteRsvp/);
});
