/**
 * PR126 — Keeper event editing + shareable event deep links.
 * Covers update persistence, Guest mutation denial, published/unpublished
 * GET visibility, and pure deep-link / share helpers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const { createEvent, getEvent, listEvents, updateEvent, SpeakeasyError } = await import("./speakeasy.js");
const {
  buildEventDeepLink,
  parseEventIdFromSearch,
  withEventSearchParam
} = await import("../client/src/event-deep-link.ts");
const {
  buildEventSharePayload,
  shareOrCopyEventLink
} = await import("../client/src/event-share.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function cleanupEvents() {
  db.prepare("DELETE FROM events").run();
}

test("Keeper can update an existing event and fields persist", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Winter Bash",
    event_date: "2026-12-20",
    description: "Bring a bottle",
    image_url: "/api/media/images/old.jpg",
    is_published: 1
  });
  const updated = updateEvent(created.id, {
    title: "Winter Bash Deluxe",
    event_date: "2026-12-21",
    description: "Doors at 7",
    image_url: "/api/media/images/new.jpg",
    is_published: 0
  });
  assert.equal(updated.title, "Winter Bash Deluxe");
  assert.equal(updated.event_date, "2026-12-21");
  assert.equal(updated.description, "Doors at 7");
  assert.equal(updated.image_url, "/api/media/images/new.jpg");
  assert.equal(updated.is_published, 0);
  const again = getEvent(created.id, true);
  assert.equal(again.title, "Winter Bash Deluxe");
  assert.equal(again.is_published, 0);
});

test("createEvent still works and defaults to published", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Spring Pour",
    event_date: "2026-04-01",
    description: "Patio open"
  });
  assert.ok(created.id > 0);
  assert.equal(created.is_published, 1);
  assert.equal(listEvents(false).length, 1);
});

test("Guest cannot update an event via PUT", async () => {
  cleanupEvents();
  const created = createEvent({
    title: "Locked Bash",
    event_date: "2026-11-01",
    description: "Keepers only edit"
  });
  const denied = await app.inject({
    method: "PUT",
    url: `/api/events/${created.id}`,
    payload: { title: "Hacked" }
  });
  assert.equal(denied.statusCode, 401);
  const still = getEvent(created.id, true);
  assert.equal(still.title, "Locked Bash");
});

test("Keeper PUT updates through the existing /api/events/:id route", async () => {
  cleanupEvents();
  const token = createTestAdminToken();
  const created = createEvent({
    title: "API Bash",
    event_date: "2026-08-08",
    description: "Before"
  });
  const res = await app.inject({
    method: "PUT",
    url: `/api/events/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: "API Bash Updated",
      event_date: "2026-08-09",
      description: "After",
      image_url: "https://example.com/party.jpg",
      is_published: 1
    }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { title: string; event_date: string; description: string; image_url: string };
  assert.equal(body.title, "API Bash Updated");
  assert.equal(body.event_date, "2026-08-09");
  assert.equal(body.description, "After");
  assert.equal(body.image_url, "https://example.com/party.jpg");
});

test("GET /api/events/:id returns published events to guests", async () => {
  cleanupEvents();
  const created = createEvent({
    title: "Public Night",
    event_date: "2026-09-15",
    description: "Open doors",
    is_published: 1
  });
  const res = await app.inject({ method: "GET", url: `/api/events/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { id: number; title: string; is_published: number };
  assert.equal(body.id, created.id);
  assert.equal(body.title, "Public Night");
  assert.equal(body.is_published, 1);
});

test("GET /api/events/:id hides unpublished events from guests", async () => {
  cleanupEvents();
  const draft = createEvent({
    title: "Secret Draft",
    event_date: "2026-10-01",
    description: "Not ready",
    is_published: 0
  });
  const guest = await app.inject({ method: "GET", url: `/api/events/${draft.id}` });
  assert.equal(guest.statusCode, 404);
  assert.equal((guest.json() as { error: string }).error, "Event not found");

  const token = createTestAdminToken();
  const keeper = await app.inject({
    method: "GET",
    url: `/api/events/${draft.id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(keeper.statusCode, 200);
  assert.equal((keeper.json() as { title: string }).title, "Secret Draft");
});

test("unknown event id is a safe not-found for guests and Keepers", async () => {
  cleanupEvents();
  const guest = await app.inject({ method: "GET", url: "/api/events/999999" });
  assert.equal(guest.statusCode, 404);
  const token = createTestAdminToken();
  const keeper = await app.inject({
    method: "GET",
    url: "/api/events/999999",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(keeper.statusCode, 404);
});

test("unpublishing immediately removes guest deep-link access", async () => {
  cleanupEvents();
  const token = createTestAdminToken();
  const created = createEvent({
    title: "Toggle Night",
    event_date: "2026-07-04",
    description: "Fireworks",
    is_published: 1
  });
  assert.equal((await app.inject({ method: "GET", url: `/api/events/${created.id}` })).statusCode, 200);

  const unpublished = await app.inject({
    method: "PUT",
    url: `/api/events/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { is_published: 0 }
  });
  assert.equal(unpublished.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/events/${created.id}` })).statusCode, 404);

  const republished = await app.inject({
    method: "PUT",
    url: `/api/events/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { is_published: 1 }
  });
  assert.equal(republished.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/events/${created.id}` })).statusCode, 200);
});

test("getEvent throws SpeakeasyError 404 for unpublished guests", () => {
  cleanupEvents();
  const draft = createEvent({
    title: "Hidden",
    event_date: "2026-01-01",
    is_published: 0
  });
  assert.throws(() => getEvent(draft.id, false), (error: unknown) => {
    assert.ok(error instanceof SpeakeasyError);
    assert.equal(error.statusCode, 404);
    return true;
  });
  assert.equal(getEvent(draft.id, true).title, "Hidden");
});

test("deep-link helpers parse and build ?event= ids", () => {
  assert.equal(parseEventIdFromSearch("?event=42"), 42);
  assert.equal(parseEventIdFromSearch("event=42&theme=dark"), 42);
  assert.equal(parseEventIdFromSearch("?event=0"), null);
  assert.equal(parseEventIdFromSearch("?event=abc"), null);
  assert.equal(parseEventIdFromSearch(""), null);
  assert.equal(
    buildEventDeepLink("https://vault.local", "/", 7),
    "https://vault.local/?event=7"
  );
  assert.equal(
    buildEventDeepLink("https://vault.local", "/app", 12),
    "https://vault.local/app?event=12"
  );
  assert.equal(withEventSearchParam("?theme=dark", 9), "?theme=dark&event=9");
  assert.equal(withEventSearchParam("?event=9&theme=dark", null), "?theme=dark");
});

test("share helpers prefer Web Share then copy-link fallback", async () => {
  const payload = buildEventSharePayload(
    { title: "Patio Pour", event_date: "2026-06-01" },
    "https://vault.local/?event=3"
  );
  assert.equal(payload.title, "Patio Pour");
  assert.equal(payload.text, "Patio Pour — 2026-06-01");
  assert.equal(payload.url, "https://vault.local/?event=3");

  const shared = await shareOrCopyEventLink(payload, {
    canShare: true,
    share: async () => {},
    clipboardWrite: async () => { throw new Error("should not copy"); }
  });
  assert.equal(shared, "shared");

  const copied = await shareOrCopyEventLink(payload, {
    canShare: false,
    share: undefined,
    clipboardWrite: async () => {}
  });
  assert.equal(copied, "copied");

  const cancelled = await shareOrCopyEventLink(payload, {
    canShare: true,
    share: async () => {
      const err = new Error("Share canceled");
      err.name = "AbortError";
      throw err;
    }
  });
  assert.equal(cancelled, "cancelled");

  const fallback = await shareOrCopyEventLink(payload, {
    canShare: false,
    share: undefined,
    clipboardWrite: undefined
  });
  assert.equal(fallback, "fallback");
});

test("Events UI wires Edit event, Share, Copy link, and deep-link helpers", () => {
  const eventsPage = readFileSync(join(root, "client/src/EventsPage.tsx"), "utf8");
  const detail = readFileSync(join(root, "client/src/EventDetail.tsx"), "utf8");
  const editor = readFileSync(join(root, "client/src/EventEditor.tsx"), "utf8");
  const app = readFileSync(join(root, "client/src/App.tsx"), "utf8");

  assert.match(eventsPage, /Edit event/);
  assert.match(eventsPage, /Event updated/);
  assert.match(eventsPage, /Link copied/);
  assert.match(eventsPage, /shareOrCopyEventLink/);
  assert.match(eventsPage, /buildEventDeepLink/);
  assert.match(eventsPage, /parseEventIdFromSearch/);
  assert.match(detail, /Share/);
  assert.match(detail, /Copy link/);
  assert.match(detail, /Edit event/);
  assert.match(editor, /Published — show to guests/);
  assert.match(editor, /ImageField/);
  assert.match(app, /parseEventIdFromSearch/);
  assert.match(app, /setPage\("events"\)/);
});
