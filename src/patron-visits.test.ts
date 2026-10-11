/**
 * Patron visit history / daily check-in log.
 * Preserves cumulative visit_count + leaderboard ranking; never fabricates dated rows for legacy counts.
 * Vault-day math and Keeper labels use America/New_York, not the host/browser timezone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import {
  BAR_TIMEZONE, formatBarTime, instantFromZonedParts, parseUtcTimestamp, parseVaultDay,
  patronRank, vaultDayBounds, vaultDayDate
} from "./speakeasy-shared.js";
import {
  adjustPatronVisits, checkInPatron, createPatron, deletePatron, deletePatronVisit,
  getPatronVisitHistory, listLeaderboard, listPatrons, listPatronsForKeeper, listVisitsForVaultDay,
  SpeakeasyError, updatePatron
} from "./speakeasy.js";

const { app, createTestAdminToken } = await import("./server.js");

/** Wall-clock America/New_York → UTC instant (month is 1–12). */
function ny(y: number, m: number, d: number, h: number, min = 0) {
  return instantFromZonedParts(y, m, d, h, min, 0);
}

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

function recordedCount(id: number) {
  return (db.prepare("SELECT COUNT(*) AS n FROM patron_visits WHERE patron_id=?").get(id) as { n: number }).n;
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
    assert.equal(recordedCount(id), 0, "historical counts must not be fabricated as dated check-ins");
  } finally {
    cleanupPatron(id);
  }
});

test("first check-in records a timestamp and increments visit_count", () => {
  const id = insertLegacyPatron(`First Check ${Date.now()}`, 2);
  try {
    const now = ny(2026, 6, 10, 18, 30);
    const result = checkInPatron(id, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.patron.visit_count, 3);
    assert.equal(result.visit.checked_in_at, now.toISOString());
    assert.equal(result.patron.last_check_in_at, now.toISOString());
    assert.match(result.notice, /6:30\s*PM/);
  } finally {
    cleanupPatron(id);
  }
});

test("multiple visits stay ordered newest-first and keep counts consistent", () => {
  const id = insertLegacyPatron(`Multi ${Date.now()}`, 0);
  try {
    const t1 = ny(2026, 6, 10, 17, 0);
    const t2 = ny(2026, 6, 11, 19, 0);
    const t3 = ny(2026, 6, 12, 20, 0);
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
    const first = ny(2026, 6, 10, 21, 15);
    const second = ny(2026, 6, 11, 1, 30); // still vault day 2026-06-10 in NY
    assert.equal(vaultDayDate(first), "2026-06-10");
    assert.equal(vaultDayDate(second), "2026-06-10");
    const one = checkInPatron(id, { now: first });
    assert.equal(one.ok, true);
    const blocked = checkInPatron(id, { now: second });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.needs_confirmation, true);
    assert.equal(blocked.previous_check_in_at, first.toISOString());
    assert.match(blocked.notice, /9:15\s*PM/);
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
    checkInPatron(a, { now: ny(2026, 6, 10, 18, 0), force: true });
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

test("daily visit log respects NY vault-day bounds and unique vs event totals", () => {
  const id = insertLegacyPatron(`Daily ${Date.now()}`, 0);
  const other = insertLegacyPatron(`Daily Other ${Date.now() + 1}`, 0);
  try {
    checkInPatron(id, { now: ny(2026, 6, 10, 22, 0), force: true });
    checkInPatron(id, { now: ny(2026, 6, 11, 2, 0), force: true });
    checkInPatron(other, { now: ny(2026, 6, 11, 3, 30), force: true });
    checkInPatron(id, { now: ny(2026, 6, 11, 4, 5), force: true });

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
    const stamped = checkInPatron(id, { now: ny(2026, 6, 10, 16, 0), force: true });
    assert.equal(stamped.ok, true);
    if (!stamped.ok) return;
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 2);

    deletePatronVisit(id, stamped.visit.id);
    const after = getPatronVisitHistory(id);
    assert.equal(after.patron.visit_count, 1);
    assert.equal(after.visits.length, 0);
    assert.equal(after.legacy_visit_count, 1);

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

test("updatePatron cannot set visit_count below recorded dated visits", () => {
  const id = insertLegacyPatron(`Count Guard ${Date.now()}`, 0);
  try {
    assert.equal(checkInPatron(id, { now: ny(2026, 6, 10, 12, 0), force: true }).ok, true);
    assert.equal(checkInPatron(id, { now: ny(2026, 6, 11, 12, 0), force: true }).ok, true);
    assert.equal(recordedCount(id), 2);
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 2);

    assert.throws(() => updatePatron(id, { visit_count: 1 }), /cannot be below 2 recorded/i);
    assert.throws(() => updatePatron(id, { visit_count: 0 }), /cannot be below 2 recorded/i);
    assert.equal(getPatronVisitHistory(id).patron.visit_count, 2);
    assert.equal(recordedCount(id), 2);

    const raised = updatePatron(id, { visit_count: 5 });
    assert.equal(raised.visit_count, 5);
    assert.equal(getPatronVisitHistory(id).legacy_visit_count, 3);
  } finally {
    cleanupPatron(id);
  }
});

test("vault day helpers use America/New_York including 23h and 25h DST spans", () => {
  assert.equal(BAR_TIMEZONE, "America/New_York");
  assert.equal(parseVaultDay("2026-06-10"), "2026-06-10");
  assert.equal(parseVaultDay("2026-13-01"), null);
  assert.equal(parseVaultDay("nope"), null);

  // Ordinary summer day (EDT): exactly 24 hours.
  const summer = vaultDayBounds("2026-06-10");
  assert.equal(summer.end.getTime() - summer.start.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(vaultDayDate(ny(2026, 6, 11, 3, 59)), "2026-06-10");
  assert.equal(vaultDayDate(ny(2026, 6, 11, 4, 0)), "2026-06-11");

  // Spring forward 2026-03-08 2AM→3AM: vault day Mar 7 is 23 real hours.
  const spring = vaultDayBounds("2026-03-07");
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 60 * 60 * 1000);
  assert.equal(vaultDayDate(ny(2026, 3, 8, 3, 30)), "2026-03-07");
  assert.equal(vaultDayDate(ny(2026, 3, 8, 4, 0)), "2026-03-08");

  // Fall back 2026-11-01 2AM→1AM: vault day Oct 31 is 25 real hours.
  const fall = vaultDayBounds("2026-10-31");
  assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * 60 * 60 * 1000);
  assert.equal(vaultDayDate(ny(2026, 11, 1, 3, 30)), "2026-10-31");
  assert.equal(vaultDayDate(ny(2026, 11, 1, 4, 0)), "2026-11-01");

  // Labels stay on bar timezone even if the host TZ differs.
  assert.equal(formatBarTime(ny(2026, 6, 10, 21, 15).toISOString()), "9:15 PM");
});

test("invalid visit-log date query is HTTP 400; omitted date defaults to current vault day", async () => {
  const token = createTestAdminToken();
  const bad = await app.inject({
    method: "GET",
    url: "/api/patrons/visits?date=not-a-date",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(bad.statusCode, 400);
  assert.match((bad.json() as { error: string }).error, /invalid vault day/i);

  const impossible = await app.inject({
    method: "GET",
    url: "/api/patrons/visits?date=2026-02-30",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(impossible.statusCode, 400);

  assert.throws(() => listVisitsForVaultDay("bogus"), SpeakeasyError);

  const ok = await app.inject({
    method: "GET",
    url: "/api/patrons/visits",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { vault_day: string }).vault_day, vaultDayDate());
});

test("check-in, duplicate confirm, void, and refresh stay consistent across board/history/log", async () => {
  const token = createTestAdminToken();
  const id = insertLegacyPatron(`Consistency ${Date.now()}`, 0);
  const headers = { authorization: `Bearer ${token}` };
  try {
    const t1 = ny(2026, 6, 10, 20, 0);
    const t2 = ny(2026, 6, 11, 1, 0);
    const first = checkInPatron(id, { now: t1 });
    assert.equal(first.ok, true);
    const dup = checkInPatron(id, { now: t2 });
    assert.equal(dup.ok, false);
    const forced = checkInPatron(id, { now: t2, force: true });
    assert.equal(forced.ok, true);
    if (!forced.ok) return;

    const board = await app.inject({ method: "GET", url: "/api/patrons", headers });
    assert.equal(board.statusCode, 200);
    const boardRow = (board.json() as { patrons: Array<{ id: number; visit_count: number; last_check_in_at?: string }> })
      .patrons.find((row) => row.id === id);
    assert.equal(boardRow?.visit_count, 2);
    assert.equal(boardRow?.last_check_in_at, t2.toISOString());

    const history = await app.inject({ method: "GET", url: `/api/patrons/${id}/visits`, headers });
    assert.equal(history.statusCode, 200);
    const historyBody = history.json() as {
      patron: { visit_count: number; last_check_in_at: string };
      visits: Array<{ id: number; checked_in_at: string }>;
      legacy_visit_count: number;
    };
    assert.equal(historyBody.patron.visit_count, 2);
    assert.equal(historyBody.visits.length, 2);
    assert.equal(historyBody.legacy_visit_count, 0);
    assert.equal(historyBody.patron.last_check_in_at, t2.toISOString());

    const log = await app.inject({
      method: "GET",
      url: "/api/patrons/visits?date=2026-06-10",
      headers
    });
    assert.equal(log.statusCode, 200);
    const logBody = log.json() as {
      check_in_count: number;
      unique_visitor_count: number;
      visits: Array<{ patron_id: number }>;
    };
    assert.equal(logBody.check_in_count, 2);
    assert.equal(logBody.unique_visitor_count, 1);
    assert.ok(logBody.visits.every((visit) => visit.patron_id === id));

    const voided = await app.inject({
      method: "DELETE",
      url: `/api/patrons/${id}/visits/${forced.visit.id}`,
      headers
    });
    assert.equal(voided.statusCode, 200);
    assert.equal((voided.json() as { visit_count: number }).visit_count, 1);

    const boardAfter = await app.inject({ method: "GET", url: "/api/patrons", headers });
    const rowAfter = (boardAfter.json() as { patrons: Array<{ id: number; visit_count: number; last_check_in_at?: string }> })
      .patrons.find((row) => row.id === id);
    assert.equal(rowAfter?.visit_count, 1);
    assert.equal(rowAfter?.last_check_in_at, t1.toISOString());

    const historyAfter = await app.inject({ method: "GET", url: `/api/patrons/${id}/visits`, headers });
    const historyAfterBody = historyAfter.json() as {
      patron: { visit_count: number };
      visits: unknown[];
      legacy_visit_count: number;
    };
    assert.equal(historyAfterBody.patron.visit_count, 1);
    assert.equal(historyAfterBody.visits.length, 1);
    assert.equal(historyAfterBody.legacy_visit_count, 0);

    const logAfter = await app.inject({
      method: "GET",
      url: "/api/patrons/visits?date=2026-06-10",
      headers
    });
    assert.equal((logAfter.json() as { check_in_count: number }).check_in_count, 1);
    assert.ok(getPatronVisitHistory(id).patron.visit_count >= recordedCount(id));
  } finally {
    cleanupPatron(id);
  }
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
  assert.equal(recordedCount(id), 0);
});

test("missing visit void and missing patron history raise SpeakeasyError", () => {
  assert.throws(() => getPatronVisitHistory(9_999_999), SpeakeasyError);
  assert.throws(() => deletePatronVisit(9_999_999, 1), SpeakeasyError);
});
