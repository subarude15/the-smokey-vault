/**
 * PR131 — Keeper event subscriber (invite list) privacy + pure helpers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const {
  createEventSubscriber,
  deleteEventSubscriber,
  listEventSubscribers
} = await import("./speakeasy.js");
const {
  buildSubscriberContactsText,
  buildSubscribersCsv,
  escapeCsvField,
  filterEventSubscribers,
  formatSubscriberContactLine,
  sanitizeCsvCell,
  subscriberContactHref
} = await import("../client/src/event-subscribers.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function cleanupSubscribers() {
  db.prepare("DELETE FROM event_subscribers").run();
}

test("Guest cannot GET the event subscriber list", async () => {
  cleanupSubscribers();
  createEventSubscriber({ name: "Jane Doe", contact_info: "jane@example.com", notes: "St Paddy" });
  const res = await app.inject({ method: "GET", url: "/api/event-subscribers" });
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(res.body, /jane@example\.com/i);
});

test("Keeper can GET the event subscriber list with expected fields", async () => {
  cleanupSubscribers();
  const created = createEventSubscriber({
    name: "Mike",
    contact_info: "610-555-1234",
    notes: "Bring ice"
  });
  const token = createTestAdminToken();
  const res = await app.inject({
    method: "GET",
    url: "/api/event-subscribers",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(res.statusCode, 200);
  const rows = res.json() as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created.id);
  assert.equal(rows[0].name, "Mike");
  assert.equal(rows[0].contact_info, "610-555-1234");
  assert.equal(rows[0].notes, "Bring ice");
  assert.equal(typeof rows[0].created_at, "string");
  assert.ok(String(rows[0].created_at).length > 0);
});

test("Guest cannot DELETE an event subscriber", async () => {
  cleanupSubscribers();
  const created = createEventSubscriber({ name: "Locked", contact_info: "locked@example.com" });
  const res = await app.inject({
    method: "DELETE",
    url: `/api/event-subscribers/${created.id}`
  });
  assert.equal(res.statusCode, 401);
  assert.equal(listEventSubscribers().length, 1);
});

test("Keeper can DELETE an event subscriber", async () => {
  cleanupSubscribers();
  const created = createEventSubscriber({ name: "Gone", contact_info: "gone@example.com" });
  const token = createTestAdminToken();
  const res = await app.inject({
    method: "DELETE",
    url: `/api/event-subscribers/${created.id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(res.statusCode, 204);
  assert.equal(listEventSubscribers().length, 0);
  assert.equal(deleteEventSubscriber(created.id), false);
});

test("POST /api/event-subscribers stays public for guest signup", async () => {
  cleanupSubscribers();
  const res = await app.inject({
    method: "POST",
    url: "/api/event-subscribers",
    payload: {
      name: "Patio Guest",
      contact_info: "guest@example.com",
      notes: "Plus one"
    }
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { ok?: boolean; id?: number };
  assert.equal(body.ok, true);
  assert.ok(typeof body.id === "number" && body.id > 0);
  const listed = listEventSubscribers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "Patio Guest");
  assert.equal(listed[0].contact_info, "guest@example.com");
  assert.equal(listed[0].notes, "Plus one");
  assert.ok(listed[0].created_at);
});

test("duplicate subscriber signup remains allowed without uniqueness merge", () => {
  cleanupSubscribers();
  createEventSubscriber({ name: "Same", contact_info: "same@example.com" });
  createEventSubscriber({ name: "Same", contact_info: "same@example.com" });
  assert.equal(listEventSubscribers().length, 2);
});

test("subscriberContactHref maps email, phone, and ambiguous text conservatively", () => {
  assert.equal(subscriberContactHref("jane@example.com"), "mailto:jane@example.com");
  assert.equal(subscriberContactHref("  mike@bar.com  "), "mailto:mike@bar.com");
  assert.equal(subscriberContactHref("610-555-1234"), "tel:6105551234");
  assert.equal(subscriberContactHref("+1 (610) 555-1234"), "tel:16105551234");
  assert.equal(subscriberContactHref("call me on Signal"), null);
  assert.equal(subscriberContactHref("not an email@"), null);
  assert.equal(subscriberContactHref("123"), null);
  assert.equal(subscriberContactHref(""), null);
});

test("filterEventSubscribers matches name, contact, and notes case-insensitively", () => {
  const rows = [
    { id: 1, name: "Jane Doe", contact_info: "jane@example.com", notes: "St. Patrick’s updates", created_at: "2026-09-07" },
    { id: 2, name: "Mike", contact_info: "610-555-1234", notes: "", created_at: "2026-09-06" },
    { id: 3, name: "Alex", contact_info: "alex@bar.com", notes: "Bring bitters", created_at: "2026-09-05" }
  ];
  assert.deepEqual(filterEventSubscribers(rows, "JANE").map((r) => r.id), [1]);
  assert.deepEqual(filterEventSubscribers(rows, "610").map((r) => r.id), [2]);
  assert.deepEqual(filterEventSubscribers(rows, "bitters").map((r) => r.id), [3]);
  assert.deepEqual(filterEventSubscribers(rows, "  ").map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(filterEventSubscribers(rows, "nobody-here").map((r) => r.id), []);
});

test("CSV escaping and contact copy formatting stay stable", () => {
  assert.equal(escapeCsvField("plain"), "plain");
  assert.equal(escapeCsvField('He said "hi"'), '"He said ""hi"""');
  assert.equal(escapeCsvField("a,b"), '"a,b"');
  assert.equal(escapeCsvField("line1\nline2"), '"line1\nline2"');

  const csv = buildSubscribersCsv([
    {
      id: 1,
      name: "Jane, Doe",
      contact_info: "jane@example.com",
      notes: 'Said "please"',
      created_at: "2026-09-07 12:00:00"
    }
  ]);
  assert.equal(
    csv,
    'Name,Contact,Notes,Joined\n"Jane, Doe",jane@example.com,"Said ""please""",2026-09-07 12:00:00'
  );

  assert.equal(
    formatSubscriberContactLine({ name: "Jane Doe", contact_info: "jane@example.com" }),
    "Jane Doe — jane@example.com"
  );
  assert.equal(
    buildSubscriberContactsText([
      { id: 1, name: "Jane Doe", contact_info: "jane@example.com", notes: "", created_at: "" },
      { id: 2, name: "Mike", contact_info: "610-555-1234", notes: "", created_at: "" }
    ]),
    "Jane Doe — jane@example.com\nMike — 610-555-1234"
  );
});

test("CSV export neutralizes spreadsheet formula injection", () => {
  assert.equal(sanitizeCsvCell("=SUM(1+1)"), "'=SUM(1+1)");
  assert.equal(sanitizeCsvCell("+123"), "'+123");
  assert.equal(sanitizeCsvCell("-123"), "'-123");
  assert.equal(sanitizeCsvCell("@something"), "'@something");
  assert.equal(sanitizeCsvCell("   =HYPERLINK(...)"), "'   =HYPERLINK(...)");

  // Ordinary values stay unchanged.
  assert.equal(sanitizeCsvCell("Jane Doe"), "Jane Doe");
  assert.equal(sanitizeCsvCell("jane@example.com"), "jane@example.com");
  assert.equal(sanitizeCsvCell("610-555-1234"), "610-555-1234");
  assert.equal(sanitizeCsvCell("Bring ice"), "Bring ice");

  // Leading + phones are formula-safe in CSV only; UI/tel: paths are unaffected.
  assert.equal(escapeCsvField("+1 (610) 555-1234"), "'+1 (610) 555-1234");
  assert.equal(escapeCsvField("=SUM(1+1)"), "'=SUM(1+1)");
  assert.equal(escapeCsvField("   =HYPERLINK(...)"), "'   =HYPERLINK(...)");

  const csv = buildSubscribersCsv([
    {
      id: 1,
      name: "=SUM(1+1)",
      contact_info: "+123",
      notes: "   =HYPERLINK(...)",
      created_at: "-123"
    },
    {
      id: 2,
      name: "Jane Doe",
      contact_info: "jane@example.com",
      notes: "Bring ice",
      created_at: "2026-09-07 12:00:00"
    },
    {
      id: 3,
      name: "@something",
      contact_info: "610-555-1234",
      notes: "",
      created_at: "2026-09-06"
    }
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "Name,Contact,Notes,Joined");
  assert.equal(lines[1], "'=SUM(1+1),'+123,'   =HYPERLINK(...),'-123");
  assert.equal(lines[2], "Jane Doe,jane@example.com,Bring ice,2026-09-07 12:00:00");
  assert.equal(lines[3], "'@something,610-555-1234,,2026-09-06");

  // On-screen contact helpers are unchanged by CSV sanitization.
  assert.equal(subscriberContactHref("+1 (610) 555-1234"), "tel:16105551234");
  assert.equal(
    formatSubscriberContactLine({ name: "Mike", contact_info: "+1 (610) 555-1234" }),
    "Mike — +1 (610) 555-1234"
  );
});

test("Keeper Invite List UI is wired on Events and stays out of messages", () => {
  const eventsPage = readFileSync(join(root, "client/src/EventsPage.tsx"), "utf8");
  const listUi = readFileSync(join(root, "client/src/EventSubscriberList.tsx"), "utf8");
  const helpers = readFileSync(join(root, "client/src/event-subscribers.ts"), "utf8");
  const messages = readFileSync(join(root, "client/src/MessagesInbox.tsx"), "utf8");
  const server = readFileSync(join(root, "src/server.ts"), "utf8");

  assert.match(eventsPage, /EventSubscriberList/);
  assert.match(eventsPage, /subscriberLoading/);
  assert.match(eventsPage, /subscriberError/);
  assert.match(eventsPage, /loadSubscribers/);
  assert.match(listUi, /INVITE LIST/);
  assert.match(listUi, /Export CSV/);
  assert.match(listUi, /Copy contacts/);
  assert.match(listUi, /Nobody has joined the invite list yet/);
  assert.match(listUi, /Could not load the invite list/);
  assert.match(listUi, /Remove \$\{subscriber\.name\} from the invite list/);
  assert.match(helpers, /subscriberContactHref/);
  assert.match(helpers, /buildSubscribersCsv/);
  assert.match(helpers, /sanitizeCsvCell/);
  assert.doesNotMatch(messages, /event-subscribers/);
  assert.doesNotMatch(messages, /EventSubscriber/);
  assert.match(server, /app\.get\("\/api\/event-subscribers"/);
  assert.match(server, /if \(requireAdmin\(request, reply\)\) return;\s*\n\s*return listEventSubscribers\(\);/);
});
