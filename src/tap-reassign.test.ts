/**
 * Keeper tap reassignment — move/swap by exchanging tap_number, preserving row id.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { db } = await import("./db.js");
const { isTapEmpty, TAP_COUNT } = await import("./catalog.js");
const { parseTapDestination, reassignTap, tapDestinationLabel } = await import("./tap-reassign.js");
const { app, createTestAdminToken } = await import("./server.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardSrc = readFileSync(join(root, "client/src/TapSpiritInventoryCard.tsx"), "utf8");
const PREFIX = "TapReassign";

function resetTap(tapNumber: number) {
  db.prepare(
    `UPDATE taps SET
      brewery_batch='', maker='', style='', abv=0, ibu=0, tapped_date=NULL,
      remaining_l=0, notes='', tasting_notes='', image_url='', flavors='[]', tags='[]',
      base_ingredient='', source_type='Commercial', keg_size_l=19.5,
      updated_at=CURRENT_TIMESTAMP
     WHERE tap_number=?`
  ).run(tapNumber);
}

function loadByNumber(tapNumber: number) {
  return db.prepare("SELECT * FROM taps WHERE tap_number=?").get(tapNumber) as Record<string, unknown>;
}

function occupy(
  tapNumber: number,
  fields: {
    beer: string;
    maker?: string;
    style?: string;
    abv?: number;
    ibu?: number;
    remaining_l?: number;
    keg_size_l?: number;
    image_url?: string;
    notes?: string;
    tasting_notes?: string;
    flavors?: string;
    tapped_date?: string;
    source_type?: string;
  }
) {
  db.prepare(
    `UPDATE taps SET
      brewery_batch=?, maker=?, style=?, abv=?, ibu=?, remaining_l=?, keg_size_l=?,
      image_url=?, notes=?, tasting_notes=?, flavors=?, tapped_date=?, source_type=?,
      updated_at=CURRENT_TIMESTAMP
     WHERE tap_number=?`
  ).run(
    fields.beer,
    fields.maker ?? `${PREFIX} Brewery`,
    fields.style ?? "IPA",
    fields.abv ?? 6.2,
    fields.ibu ?? 40,
    fields.remaining_l ?? 12.5,
    fields.keg_size_l ?? 19.5,
    fields.image_url ?? "/api/media/images/tap-reassign.jpg",
    fields.notes ?? "keeper notes",
    fields.tasting_notes ?? "citrus",
    fields.flavors ?? '["citrus"]',
    fields.tapped_date ?? "2026-10-01",
    fields.source_type ?? "Commercial",
    tapNumber
  );
  return loadByNumber(tapNumber);
}

afterEach(() => {
  for (let n = 1; n <= TAP_COUNT; n++) resetTap(n);
});

test("parseTapDestination accepts 1–7 integers only", () => {
  assert.equal(parseTapDestination(1), 1);
  assert.equal(parseTapDestination("7"), 7);
  assert.equal(parseTapDestination(0), null);
  assert.equal(parseTapDestination(8), null);
  assert.equal(parseTapDestination(2.5), null);
  assert.equal(parseTapDestination("x"), null);
});

test("move occupied tap onto empty tap preserves identity and beer fields", () => {
  const source = occupy(2, { beer: `${PREFIX} Pale`, maker: "Vault Co", remaining_l: 8.25, ibu: 33 });
  resetTap(4);
  const sourceId = Number(source.id);
  const before = { ...source };

  const result = reassignTap(sourceId, 4);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.noop, false);
  assert.equal(result.swapped, false);
  assert.equal(result.from_tap_number, 2);
  assert.equal(result.to_tap_number, 4);

  const moved = loadByNumber(4);
  const vacated = loadByNumber(2);
  assert.equal(Number(moved.id), sourceId);
  assert.equal(moved.brewery_batch, before.brewery_batch);
  assert.equal(moved.maker, before.maker);
  assert.equal(moved.style, before.style);
  assert.equal(moved.abv, before.abv);
  assert.equal(moved.ibu, before.ibu);
  assert.equal(moved.remaining_l, before.remaining_l);
  assert.equal(moved.keg_size_l, before.keg_size_l);
  assert.equal(moved.image_url, before.image_url);
  assert.equal(moved.notes, before.notes);
  assert.equal(moved.tasting_notes, before.tasting_notes);
  assert.equal(moved.flavors, before.flavors);
  assert.equal(moved.tapped_date, before.tapped_date);
  assert.equal(isTapEmpty(vacated), true);
  assert.notEqual(Number(vacated.id), sourceId);
});

test("swap two occupied taps exchanges positions without losing either beer", () => {
  const a = occupy(2, { beer: `${PREFIX} Red`, maker: "Alpha", remaining_l: 10, image_url: "/a.jpg" });
  const b = occupy(4, { beer: `${PREFIX} Stout`, maker: "Beta", remaining_l: 3, image_url: "/b.jpg", style: "Stout" });
  const aId = Number(a.id);
  const bId = Number(b.id);

  const result = reassignTap(aId, 4);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.swapped, true);

  const at2 = loadByNumber(2);
  const at4 = loadByNumber(4);
  assert.equal(Number(at4.id), aId);
  assert.equal(at4.brewery_batch, `${PREFIX} Red`);
  assert.equal(at4.image_url, "/a.jpg");
  assert.equal(Number(at2.id), bId);
  assert.equal(at2.brewery_batch, `${PREFIX} Stout`);
  assert.equal(at2.image_url, "/b.jpg");
  assert.equal(at2.style, "Stout");
});

test("reassign to current tap is a no-op", () => {
  const source = occupy(3, { beer: `${PREFIX} Stay` });
  const result = reassignTap(Number(source.id), 3);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.noop, true);
  assert.equal(result.swapped, false);
  assert.equal(Number(loadByNumber(3).id), Number(source.id));
  assert.equal(loadByNumber(3).brewery_batch, `${PREFIX} Stay`);
});

test("failed reassign leaves original tap state intact", () => {
  const source = occupy(2, { beer: `${PREFIX} Guard`, remaining_l: 9 });
  const emptyBefore = loadByNumber(5);
  const bad = reassignTap(Number(source.id), 99);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.statusCode, 400);

  const still = loadByNumber(2);
  assert.equal(Number(still.id), Number(source.id));
  assert.equal(still.brewery_batch, `${PREFIX} Guard`);
  assert.equal(still.remaining_l, 9);
  assert.equal(isTapEmpty(loadByNumber(5)), isTapEmpty(emptyBefore));

  const emptyMove = reassignTap(Number(emptyBefore.id), 2);
  assert.equal(emptyMove.ok, false);
  if (emptyMove.ok) return;
  assert.equal(emptyMove.statusCode, 400);
  assert.equal(loadByNumber(2).brewery_batch, `${PREFIX} Guard`);
});

test("POST /api/inventory/taps/:id/reassign is Keeper-only and refreshes ordered taps", async () => {
  const source = occupy(2, { beer: `${PREFIX} API Pale` });
  resetTap(4);
  const token = createTestAdminToken();

  const guest = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${source.id}/reassign`,
    payload: { to_tap_number: 4 }
  });
  assert.equal(guest.statusCode, 401);
  assert.equal(loadByNumber(2).brewery_batch, `${PREFIX} API Pale`);
  assert.equal(isTapEmpty(loadByNumber(4)), true);

  const move = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${source.id}/reassign`,
    headers: { authorization: `Bearer ${token}` },
    payload: { to_tap_number: 4 }
  });
  assert.equal(move.statusCode, 200);
  const body = move.json() as {
    noop: boolean;
    swapped: boolean;
    taps: Array<Record<string, unknown>>;
  };
  assert.equal(body.noop, false);
  assert.equal(body.swapped, false);
  assert.equal(body.taps.length, TAP_COUNT);
  assert.deepEqual(
    body.taps.map((row) => Number(row.tap_number)),
    Array.from({ length: TAP_COUNT }, (_, i) => i + 1)
  );
  const moved = body.taps.find((row) => Number(row.tap_number) === 4);
  assert.equal(Number(moved?.id), Number(source.id));
  assert.equal(moved?.brewery_batch, `${PREFIX} API Pale`);

  occupy(2, { beer: `${PREFIX} API Stout`, style: "Stout" });
  const swap = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${source.id}/reassign`,
    headers: { authorization: `Bearer ${token}` },
    payload: { to_tap_number: 2 }
  });
  assert.equal(swap.statusCode, 200);
  assert.equal(swap.json().swapped, true);
  assert.equal(loadByNumber(2).brewery_batch, `${PREFIX} API Pale`);
  assert.equal(loadByNumber(4).brewery_batch, `${PREFIX} API Stout`);

  const noop = await app.inject({
    method: "POST",
    url: `/api/inventory/taps/${source.id}/reassign`,
    headers: { authorization: `Bearer ${token}` },
    payload: { to_tap_number: 2 }
  });
  assert.equal(noop.statusCode, 200);
  assert.equal(noop.json().noop, true);
});

test("Keeper Move to tap UI is gated and touch-friendly destination picker is present", () => {
  assert.match(cardSrc, /Move to tap/);
  assert.match(cardSrc, /TapReassignModal/);
  assert.match(cardSrc, /\{admin \? <div className="keeper-card-controls"/);
  assert.match(cardSrc, /onClick=\{openMove\}/);
  assert.doesNotMatch(cardSrc, /onDrag|draggable/);
  assert.match(cardSrc, /confirm\([\s\S]*Swap Tap/);
  assert.equal(tapDestinationLabel({ tap_number: 3, brewery_batch: "" }), "Tap 3 · Empty");
  assert.equal(
    tapDestinationLabel({ tap_number: 2, brewery_batch: "House IPA" }),
    "Tap 2 · House IPA"
  );
});
