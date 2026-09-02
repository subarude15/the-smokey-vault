/**
 * High-severity auth holes: empty session secrets, settings leaks, and
 * unauthenticated Import Review writes from public barcode lookups.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken, sessionSecret } = await import("./server.js");
const { createAdminToken, isAdmin } = await import("./auth.js");
const { db, getSetting, setPin } = await import("./db.js");

const MIXER_UPC = "012345678905";

function wipeMixerQueue() {
  db.prepare("DELETE FROM import_queue WHERE upc=?").run(MIXER_UPC);
}

function mixerQueueCount() {
  return (db.prepare("SELECT COUNT(*) AS c FROM import_queue WHERE upc=?").get(MIXER_UPC) as { c: number }).c;
}

test("live session secret is never empty; empty-HMAC tokens cannot unlock admin", () => {
  assert.ok(sessionSecret.trim().length > 16);
  assert.notEqual(sessionSecret, "replace-with-a-long-random-value");
  assert.notEqual(sessionSecret, `${process.env.DB_PATH}:smokey-vault`);

  const forged = createAdminToken("");
  assert.equal(isAdmin(`Bearer ${forged}`, sessionSecret), false);

  const real = createTestAdminToken();
  assert.equal(isAdmin(`Bearer ${real}`, sessionSecret), true);
});

test("GET /api/settings never returns pinHash or sessionSecret", async () => {
  const token = createTestAdminToken();
  const stored = getSetting("sessionSecret");
  const res = await app.inject({
    method: "GET",
    url: "/api/settings",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal("pinHash" in body, false);
  assert.equal("sessionSecret" in body, false);
  const raw = res.body;
  assert.equal(raw.includes("pinHash"), false);
  if (stored) assert.equal(raw.includes(stored), false);
  assert.equal(raw.includes(sessionSecret), false);
});

test("public barcode lookup does not write Import Review; keeper miss still does", async () => {
  wipeMixerQueue();
  setPin(process.env.DEFAULT_PIN ?? "1234");
  try {
    const guest = await app.inject({
      method: "GET",
      url: `/api/lookup/barcode?code=${MIXER_UPC}&kind=mixers`
    });
    assert.equal(guest.statusCode, 200);
    const guestBody = guest.json() as { reason?: string; source?: string };
    assert.ok(guestBody.reason || guestBody.source === "not_found");
    assert.equal(mixerQueueCount(), 0, "guest lookup must not enqueue a review row");

    const token = createTestAdminToken();
    const keeper = await app.inject({
      method: "GET",
      url: `/api/lookup/barcode?code=${MIXER_UPC}&kind=mixers`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(keeper.statusCode, 200);
    assert.ok(mixerQueueCount() >= 1, "keeper miss still lands in Import Review");
    const row = db.prepare("SELECT upc, status FROM import_queue WHERE upc=?").get(MIXER_UPC) as
      | { upc: string; status: string }
      | undefined;
    assert.equal(row?.upc, MIXER_UPC);
    assert.notEqual(row?.status, "pending");
  } finally {
    wipeMixerQueue();
  }
});
