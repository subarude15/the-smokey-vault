/**
 * Patron visit history / daily check-in log.
 * Preserves cumulative visit_count + leaderboard ranking; never fabricates dated rows for legacy counts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import {
  parseUtcTimestamp, parseVaultDay, patronRank, vaultDayBounds, vaultDayDate
} from "./speakeasy-shared.js";
import {
  adjustPatronVisits, checkInPatron, createPatron, deletePatron, deletePatronVisit,
  getPatronVisitHistory, listLeaderboard, listPatrons, listPatronsForKeeper, listVisitsForVaultDay,
  SpeakeasyError
} from "./speakeasy.js";

const { app, createTestAdminToken } = await import("./server.js");

function cleanupPatron(id: number) {
  db.prepare("DELETE FROM patron_visits WHERE patron_id=?").run(id);
  db.prepare("DELETE FROM patrons WHERE id=?").run(id);
}

function insertLegacyPatron(name: string, visitCount: number) {
  const result = db.prepare(
    "INSERT INTO patrons(name, nickname, visit_count, notes) VALUES(?, '', ?, '')"
  ).run(name, visitCount);
  return Number(result.lastInsertRowid);
}

test("patron_visits migration is additive and does not reset patron rows", () => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('patrons', 'patron_visits')"
  ).all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name).sort(), ["patron_visits", "patrons"]);

  const name = `Legacy Keep ${Date.now()}`;
  const id = insertLegacyPatron(name, 12);
  try {
    const before = db.prepare("SELECT visit_count, name FROM patrons WHERE id=?").get(id) as {
      visit_count: number; name: string;
    };
    assert.equal(before.visit_count, 12);
    assert.equal(before.name, name);
    const visits = db.prepare("SELECT COUNT(*) AS n FROM patron_visits WHERE patron_id=?").get(id) as { n: number };
    assert.equal(visits.n, 0, "historical counts must not be fabricated as dated check-ins");
  } finally {
    cleanupPatron(id);
  }
});

test("first check-in records a timestamp and increments visit_count", () => {
  const id = insertLegacyPatron(`First Check ${Date.now()}`, 2);
  try {
    const now = new Date(2026, 5, 10, 18, 30, 0);
    const result = checkInPatron(id, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.patron.visit_count, 3);
    assert.equal(result.visit.checked_in_at, now.toISOString());
    assert.equal(result.patron.last_check_in_at, now.toISOString());
  } finally {
    cleanupPatron(id);
  }
});

test("multiple visits stay ordered newest-first and keep counts consistent", () => {
  const id = insertLegacyPatron(`Multi ${Date.now()}`, 0);
  try {
    const t1 = new Date(2026, 5, 10, 17, 0, 0);
    const t2 = new Date(2026, 5, 11, 19, 0, 0);
    const t3 = new Date(2026, 5, 12, 20, 0, 0);
    assert.equal(checkInPatron(id, { now: t1, force: true }).ok, true);
    assert.equal(checkInPatron(id, { now: t2, force: true }).ok, true);
    assert.equal(checkInPatron(id, { now: t3, force: true }).ok, true);
    const history = getPatronVisitHistory(id);
    assert.equal(history.patron.visit_count, 3);
    assert.deepEqual(
      history.visits.map((visit) => visit.checked_in_at),
      [t3.toISOString(), t2.toISOString(), t1.toISOString()]
    );
    assert.equal(history.legacy_visit_count, 0);
  } finally {
    cleanupPatron(id);
  }
});

test("same vault-day second check-in requires confirmation, then allows an explicit repeat", () => {
  const id = insertLegacyPatron(`Dup ${Date.now()}`, 0);
  try {
    const first = new Date(2026, 5, 10, 21, 15, 0);
    const second = new Date(2026, 5, 11, 1, 30, 0); // still vault day 2026-06-10
    assert.equal(vaultDayDate(first), vaultDayDate(second));
    const one = checkInPatron(id, { now: first });
    assert.equal(one.ok, true);
    const blocked = checkInPatron(id, { now: second });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.needs_confirmation, true);
    assert.equal(blocked.previous_check_in_at, first.toISOString());
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 1);

    const forced = checkInPatron(id, { now: second, force: true });
    assert.equal(forced.ok, true);
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 2);
    assert.equal(getPatronVisitHistory(id).visits.length, 2);
  } finally {
    cleanupPatron(id);
  }
});

test("legacy visit surplus is distinguished from dated rows; ranking stays visit_count based", () => {
  const a = insertLegacyPatron(`Legacy A ${Date.now()}`, 10);
  const b = insertLegacyPatron(`Legacy B ${Date.now() + 1}`, 3);
  try {
    checkInPatron(a, { now: new Date(2026, 5, 10, 18, 0, 0), force: true });
    const history = getPatronVisitHistory(a);
    assert.equal(history.patron.visit_count, 11);
    assert.equal(history.visits.length, 1);
    assert.equal(history.legacy_visit_count, 10);

    const ranked = patronRank(listPatrons());
    const indexA = ranked.findIndex((patron) => patron.id === a);
    const indexB = ranked.findIndex((patron) => patron.id === b);
    assert.ok(indexA >= 0 && indexB >= 0);
    assert.ok(indexA < indexB);
  } finally {
    cleanupPatron(a);
    cleanupPatron(b);
  }
});

test("daily visit log respects vault-day bounds and unique vs event totals", () => {
  const id = insertLegacyPatron(`Daily ${Date.now()}`, 0);
  const other = insertLegacyPatron(`Daily Other ${Date.now() + 1}`, 0);
  try {
    // Vault day 2026-06-10: local 4:00 AM Jun 10 → 4:00 AM Jun 11
    checkInPatron(id, { now: new Date(2026, 5, 10, 22, 0, 0), force: true });
    checkInPatron(id, { now: new Date(2026, 5, 11, 2, 0, 0), force: true });
    checkInPatron(other, { now: new Date(2026, 5, 11, 3, 30, 0), force: true });
    // Next vault day
    checkInPatron(id, { now: new Date(2026, 5, 11, 4, 5, 0), force: true });

    const day = listVisitsForVaultDay("2026-06-10");
    assert.equal(day.vault_day, "2026-06-10");
    assert.equal(day.check_in_count, 3);
    assert.equal(day.unique_visitor_count, 2);
    assert.ok(day.visits.every((visit) => vaultDayDate(parseUtcTimestamp(visit.checked_in_at)) === "2026-06-10"));

    const next = listVisitsForVaultDay("2026-06-11");
    assert.equal(next.check_in_count, 1);
    assert.equal(next.unique_visitor_count, 1);
  } finally {
    cleanupPatron(id);
    cleanupPatron(other);
  }
});

test("voiding a recorded visit decrements count; legacy-only decrement refuses when no surplus", () => {
  const id = insertLegacyPatron(`Void ${Date.now()}`, 1);
  try {
    const stamped = checkInPatron(id, { now: new Date(2026, 5, 10, 16, 0, 0), force: true });
    assert.equal(stamped.ok, true);
    if (!stamped.ok) return;
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 2);

    deletePatronVisit(id, stamped.visit.id);
    const after = getPatronVisitHistory(id);
    assert.equal(after.patron.visit_count, 1);
    assert.equal(after.visits.length, 0);
    assert.equal(after.legacy_visit_count, 1);

    // One legacy surplus remains — Minus is allowed once.
    adjustPatronVisits(id, -1);
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 0);
    assert.throws(() => adjustPatronVisits(id, -1), /specific recorded visit/i);
  } finally {
    cleanupPatron(id);
  }
});

test("createPatron records one dated walk-in without fabricating extras", () => {
  const patron = createPatron({ name: `Walk-in ${Date.now()}`, visit_count: 4 });
  try {
    const history = getPatronVisitHistory(patron.id);
    assert.equal(history.patron.visit_count, 4);
    assert.equal(history.visits.length, 1);
    assert.equal(history.legacy_visit_count, 3);
    assert.ok(history.patron.last_check_in_at);
  } finally {
    cleanupPatron(patron.id);
  }
});

test("vault day helpers parse bounds and reject impossible dates", () => {
  assert.equal(parseVaultDay("2026-06-10"), "2026-06-10");
  assert.equal(parseVaultDay("2026-13-01"), null);
  assert.equal(parseVaultDay("nope"), null);
  const { start, end } = vaultDayBounds("2026-06-10");
  assert.equal(start.getHours(), 4);
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(vaultDayDate(new Date(2026, 5, 11, 3, 59)), "2026-06-10");
  assert.equal(vaultDayDate(new Date(2026, 5, 11, 4, 0)), "2026-06-11");
});

test("Keeper visit APIs require auth; guest leaderboard stays public and free of last_check_in", async () => {
  const token = createTestAdminToken();
  const patron = createPatron({ name: `Auth Pat ${Date.now()}` });
  try {
    const guestBoard = await app.inject({ method: "GET", url: "/api/patrons" });
    assert.equal(guestBoard.statusCode, 200);
    const guestBody = guestBoard.json() as { patrons: Array<Record<string, unknown>>; admin: boolean };
    assert.equal(guestBody.admin, false);
    for (const row of guestBody.patrons) {
      assert.equal("last_check_in_at" in row, false);
    }

    const deniedHistory = await app.inject({ method: "GET", url: `/api/patrons/${patron.id}/visits` });
    assert.equal(deniedHistory.statusCode, 401);

    const deniedLog = await app.inject({ method: "GET", url: "/api/patrons/visits" });
    assert.equal(deniedLog.statusCode, 401);

    const deniedCheckIn = await app.inject({
      method: "POST",
      url: `/api/patrons/${patron.id}/check-in`,
      payload: {}
    });
    assert.equal(deniedCheckIn.statusCode, 401);

    const okHistory = await app.inject({
      method: "GET",
      url: `/api/patrons/${patron.id}/visits`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(okHistory.statusCode, 200);
    assert.ok((okHistory.json() as { visits: unknown[] }).visits.length >= 1);

    const okLog = await app.inject({
      method: "GET",
      url: `/api/patrons/visits?date=${vaultDayDate()}`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(okLog.statusCode, 200);

    const keeperList = await app.inject({
      method: "GET",
      url: "/api/patrons",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(keeperList.statusCode, 200);
    const keeperBody = keeperList.json() as { patrons: Array<{ id: number; last_check_in_at?: string | null }>; admin: boolean };
    assert.equal(keeperBody.admin, true);
    const row = keeperBody.patrons.find((entry) => entry.id === patron.id);
    assert.ok(row?.last_check_in_at);

    assert.ok(listLeaderboard().length <= 15);
    assert.ok(listPatronsForKeeper().some((entry) => entry.id === patron.id && entry.last_check_in_at));
  } finally {
    deletePatron(patron.id);
  }
});

test("deletePatron cascades dated visits", () => {
  const patron = createPatron({ name: `Cascade ${Date.now()}` });
  const id = patron.id;
  assert.equal(getPatronVisitHistory(id).visits.length, 1);
  assert.equal(deletePatron(id), true);
  const leftover = db.prepare("SELECT COUNT(*) AS n FROM patron_visits WHERE patron_id=?").get(id) as { n: number };
  assert.equal(leftover.n, 0);
});

test("missing visit void and missing patron history raise SpeakeasyError", () => {
  assert.throws(() => getPatronVisitHistory(9_999_999), SpeakeasyError);
  assert.throws(() => deletePatronVisit(9_999_999, 1), SpeakeasyError);
});
