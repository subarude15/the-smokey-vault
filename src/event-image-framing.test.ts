/**
 * PR140 — Event image crop / resize controls.
 * Non-destructive focal X/Y + zoom framing for event artwork.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const { createEvent, getEvent, updateEvent } = await import("./speakeasy.js");
const {
  DEFAULT_EVENT_IMAGE_FRAMING,
  clampEventFocal,
  clampEventZoom,
  eventImageFramingStyle,
  framingFromPointerDrag,
  normalizeEventImageFraming,
  nudgeEventFocal
} = await import("./event-image-framing.js");
const {
  emptyEventDraft,
  eventToEditorValues
} = await import("../client/src/EventEditor.tsx");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function cleanupEvents() {
  db.prepare("DELETE FROM events").run();
}

test("legacy event with no crop metadata uses framing defaults", () => {
  cleanupEvents();
  // Simulate a pre-PR140 insert that only set classic columns; ensureColumn defaults apply.
  const result = db.prepare(
    "INSERT INTO events(title, event_date, description, image_url, is_published) VALUES(?,?,?,?,1)"
  ).run("Legacy Night", "2026-05-01", "Old row", "/api/media/images/legacy.jpg");
  const event = getEvent(Number(result.lastInsertRowid), true);
  assert.equal(event.image_url, "/api/media/images/legacy.jpg");
  assert.equal(event.image_focal_x, 50);
  assert.equal(event.image_focal_y, 50);
  assert.equal(event.image_zoom, 1);

  const style = eventImageFramingStyle(event);
  assert.equal(style.objectFit, "cover");
  assert.equal(style.objectPosition, "50% 50%");
  assert.equal(style.transform, "scale(1)");
  assert.equal(style.transformOrigin, "50% 50%");
});

test("normalizeEventImageFraming clamps and defaults safely", () => {
  assert.deepEqual(normalizeEventImageFraming(null), DEFAULT_EVENT_IMAGE_FRAMING);
  assert.deepEqual(normalizeEventImageFraming({}), DEFAULT_EVENT_IMAGE_FRAMING);
  assert.equal(clampEventFocal(-10), 0);
  assert.equal(clampEventFocal(140), 100);
  assert.equal(clampEventZoom(0.2), 1);
  assert.equal(clampEventZoom(9), 3);
  assert.deepEqual(
    normalizeEventImageFraming({ image_focal_x: 12.345, image_focal_y: "80", image_zoom: "1.5" }),
    { image_focal_x: 12.35, image_focal_y: 80, image_zoom: 1.5 }
  );
});

test("existing crop metadata populates edit state correctly", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Framed Bash",
    event_date: "2026-06-01",
    image_url: "/api/media/images/party.jpg",
    image_focal_x: 20,
    image_focal_y: 75,
    image_zoom: 1.8,
    is_published: 1
  });
  const values = eventToEditorValues(created);
  assert.equal(values.image_url, "/api/media/images/party.jpg");
  assert.equal(values.image_focal_x, 20);
  assert.equal(values.image_focal_y, 75);
  assert.equal(values.image_zoom, 1.8);
});

test("reposition and zoom helpers update framing draft math", () => {
  const base = { ...DEFAULT_EVENT_IMAGE_FRAMING };
  const nudged = nudgeEventFocal(base, "x", -10);
  assert.equal(nudged.image_focal_x, 40);
  const zoomed = normalizeEventImageFraming({ ...nudged, image_zoom: 2 });
  assert.equal(zoomed.image_zoom, 2);
  const dragged = framingFromPointerDrag(zoomed, 50, 0, 200, 100);
  // Dragging right decreases focal X.
  assert.ok(dragged.image_focal_x < zoomed.image_focal_x);
});

test("reset restores defaults in editor draft helpers", () => {
  const draft = emptyEventDraft();
  assert.deepEqual(
    {
      image_focal_x: draft.image_focal_x,
      image_focal_y: draft.image_focal_y,
      image_zoom: draft.image_zoom
    },
    DEFAULT_EVENT_IMAGE_FRAMING
  );
  const reset = normalizeEventImageFraming({
    image_focal_x: 10,
    image_focal_y: 90,
    image_zoom: 2.5
  });
  assert.notDeepEqual(reset, DEFAULT_EVENT_IMAGE_FRAMING);
  assert.deepEqual(normalizeEventImageFraming(DEFAULT_EVENT_IMAGE_FRAMING), DEFAULT_EVENT_IMAGE_FRAMING);
});

test("create payload persists crop metadata", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Crop Create",
    event_date: "2026-07-01",
    description: "Framed",
    image_url: "/api/media/images/create.jpg",
    image_focal_x: 15,
    image_focal_y: 85,
    image_zoom: 2.25,
    is_published: 1
  });
  assert.equal(created.image_focal_x, 15);
  assert.equal(created.image_focal_y, 85);
  assert.equal(created.image_zoom, 2.25);
  const again = getEvent(created.id, true);
  assert.equal(again.image_focal_x, 15);
  assert.equal(again.image_zoom, 2.25);
});

test("edit payload persists crop metadata", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Crop Edit",
    event_date: "2026-07-02",
    image_url: "/api/media/images/edit.jpg",
    is_published: 1
  });
  const updated = updateEvent(created.id, {
    image_focal_x: 5,
    image_focal_y: 95,
    image_zoom: 2.5
  });
  assert.equal(updated.image_url, "/api/media/images/edit.jpg");
  assert.equal(updated.image_focal_x, 5);
  assert.equal(updated.image_focal_y, 95);
  assert.equal(updated.image_zoom, 2.5);
});

test("replacing image without framing resets stale crop state", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Replace Photo",
    event_date: "2026-07-03",
    image_url: "/api/media/images/old.jpg",
    image_focal_x: 10,
    image_focal_y: 10,
    image_zoom: 2,
    is_published: 1
  });
  const updated = updateEvent(created.id, {
    image_url: "/api/media/images/new.jpg"
  });
  assert.equal(updated.image_url, "/api/media/images/new.jpg");
  assert.equal(updated.image_focal_x, 50);
  assert.equal(updated.image_focal_y, 50);
  assert.equal(updated.image_zoom, 1);
});

test("removing image clears crop state", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Clear Photo",
    event_date: "2026-07-04",
    image_url: "/api/media/images/gone.jpg",
    image_focal_x: 0,
    image_focal_y: 100,
    image_zoom: 3,
    is_published: 1
  });
  const updated = updateEvent(created.id, { image_url: "" });
  assert.equal(updated.image_url, "");
  assert.equal(updated.image_focal_x, 50);
  assert.equal(updated.image_focal_y, 50);
  assert.equal(updated.image_zoom, 1);
});

test("partial publish toggle does not wipe framing", () => {
  cleanupEvents();
  const created = createEvent({
    title: "Keep Framing",
    event_date: "2026-07-05",
    image_url: "/api/media/images/keep.jpg",
    image_focal_x: 30,
    image_focal_y: 70,
    image_zoom: 1.4,
    is_published: 1
  });
  const updated = updateEvent(created.id, { is_published: 0 });
  assert.equal(updated.is_published, 0);
  assert.equal(updated.image_focal_x, 30);
  assert.equal(updated.image_focal_y, 70);
  assert.equal(updated.image_zoom, 1.4);
});

test("guest GET exposes framing needed to render published events", async () => {
  cleanupEvents();
  const created = createEvent({
    title: "Guest Frame",
    event_date: "2026-08-01",
    image_url: "/api/media/images/guest.jpg",
    image_focal_x: 22,
    image_focal_y: 66,
    image_zoom: 1.2,
    is_published: 1
  });
  const res = await app.inject({ method: "GET", url: `/api/events/${created.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    image_url: string;
    image_focal_x: number;
    image_focal_y: number;
    image_zoom: number;
  };
  assert.equal(body.image_url, "/api/media/images/guest.jpg");
  assert.equal(body.image_focal_x, 22);
  assert.equal(body.image_focal_y, 66);
  assert.equal(body.image_zoom, 1.2);
});

test("Keeper create/update API persists framing with the event", async () => {
  cleanupEvents();
  const token = createTestAdminToken();
  const created = await app.inject({
    method: "POST",
    url: "/api/events",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: "API Frame",
      event_date: "2026-08-02",
      description: "ok",
      image_url: "https://example.com/party.jpg",
      image_focal_x: 18,
      image_focal_y: 42,
      image_zoom: 1.75,
      is_published: 1
    }
  });
  assert.equal(created.statusCode, 201);
  const body = created.json() as {
    id: number;
    image_url: string;
    image_focal_x: number;
    image_focal_y: number;
    image_zoom: number;
  };
  assert.equal(body.image_url, "https://example.com/party.jpg");
  assert.equal(body.image_focal_x, 18);
  assert.equal(body.image_focal_y, 42);
  assert.equal(body.image_zoom, 1.75);

  const updated = await app.inject({
    method: "PUT",
    url: `/api/events/${body.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      image_focal_x: 60,
      image_focal_y: 40,
      image_zoom: 2
    }
  });
  assert.equal(updated.statusCode, 200);
  const next = updated.json() as { image_focal_x: number; image_focal_y: number; image_zoom: number };
  assert.equal(next.image_focal_x, 60);
  assert.equal(next.image_focal_y, 40);
  assert.equal(next.image_zoom, 2);
});

test("cancel does not independently persist crop — no crop-only mutation route", () => {
  const eventsPage = readFileSync(join(root, "client/src/EventsPage.tsx"), "utf8");
  const editor = readFileSync(join(root, "client/src/EventEditor.tsx"), "utf8");
  const adjuster = readFileSync(join(root, "client/src/EventImageAdjuster.tsx"), "utf8");
  // Crop apply stays in editor draft; event save is the only persistence path.
  assert.match(editor, /onApply=\{\(next\) => \{/);
  assert.match(editor, /setDraft\(\{/);
  assert.match(editor, /setAdjusting\(false\)/);
  assert.doesNotMatch(editor, /api\(.*image_focal/);
  assert.doesNotMatch(adjuster, /\/api\/events/);
  assert.match(eventsPage, /image_focal_x: values\.image_focal_x/);
  assert.match(eventsPage, /image_zoom: values\.image_zoom/);
  assert.match(editor, /onCancel/);
});

test("event card and detail rendering apply framing via EventImageMedia", () => {
  const eventsPage = readFileSync(join(root, "client/src/EventsPage.tsx"), "utf8");
  const detail = readFileSync(join(root, "client/src/EventDetail.tsx"), "utf8");
  const media = readFileSync(join(root, "client/src/EventImageMedia.tsx"), "utf8");
  const css = readFileSync(join(root, "client/src/styles.css"), "utf8");
  const editor = readFileSync(join(root, "client/src/EventEditor.tsx"), "utf8");
  const imageField = readFileSync(join(root, "client/src/ImageField.tsx"), "utf8");

  assert.match(eventsPage, /EventImageMedia/);
  assert.match(eventsPage, /event-card-image/);
  assert.match(detail, /EventImageMedia/);
  assert.match(detail, /event-detail-image/);
  assert.match(media, /eventImageFramingStyle/);
  assert.match(css, /\.event-image-well/);
  assert.match(css, /\.event-card-image/);
  assert.match(css, /object-fit:cover/);
  assert.match(editor, /Adjust photo/);
  assert.match(editor, /EventImageAdjuster/);
  assert.match(editor, /DEFAULT_EVENT_IMAGE_FRAMING/);
  // Shared ImageField must not gain event-specific crop behavior.
  assert.doesNotMatch(imageField, /image_focal|EventImageAdjuster|Adjust photo/);
});

test("editor resets framing when image is replaced or removed", () => {
  const editor = readFileSync(join(root, "client/src/EventEditor.tsx"), "utf8");
  assert.match(editor, /function setImageUrl/);
  assert.match(editor, /Replacing the photo clears stale crop/);
  assert.match(editor, /image_url: ""/);
  assert.match(editor, /\.\.\.DEFAULT_EVENT_IMAGE_FRAMING/);
});
