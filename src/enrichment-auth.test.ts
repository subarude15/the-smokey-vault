/**
 * Auth + enrichment access: patrons may read enrichment; mutations stay admin-gated.
 * Imports the Fastify app with SMOKEY_TEST_NO_LISTEN so listen/worker are skipped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { pinAccepted, isAdmin, createAdminToken } = await import("./auth.js");
const { db, setPin, getSetting, verifyPin } = await import("./db.js");
const { sessionSecret } = await import("./server.js");

const UPC = "080244880001";

function insertSpirit(name = "Auth Enrich Bottle") {
  const result = db
    .prepare(
      `INSERT INTO spirits (name, brand, category, abv, volume_ml, upc, notes, tasting_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, "Auth Brand", "Bourbon", 45, 750, UPC, "personal", "tasting");
  return Number(result.lastInsertRowid);
}

function cleanup(id?: number) {
  if (id) db.prepare("DELETE FROM spirits WHERE id=?").run(id);
  db.prepare("DELETE FROM spirits WHERE upc=?").run(UPC);
  db.prepare("DELETE FROM enrichment_jobs WHERE upc=?").run(UPC);
  // Restore a known keeper PIN after PIN-change tests.
  setPin(process.env.DEFAULT_PIN ?? "1234");
  delete process.env.ADMIN_PIN;
  delete process.env.MASTER_PIN;
}

test("public clients can read bottle enrichment without an admin session", async () => {
  cleanup();
  const id = insertSpirit();
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/inventory/spirits/${id}/enrichment`
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      entityId: number;
      identity: { name: { value: string } };
      enrichment: { jobs: unknown[] };
    };
    assert.equal(body.entityId, id);
    assert.equal(body.identity.name.value, "Auth Enrich Bottle");
    assert.ok(Array.isArray(body.enrichment.jobs));

    const raw = res.body;
    assert.equal(raw.includes("pinHash"), false);
    assert.equal(raw.includes("ADMIN_PIN"), false);
    assert.equal(raw.includes("MASTER_PIN"), false);
    assert.equal(raw.includes("SESSION_SECRET"), false);
    assert.equal(raw.includes(getSetting("pinHash") ?? "___none___"), false);
  } finally {
    cleanup(id);
  }
});

test("enrichment has no public mutation routes", async () => {
  cleanup();
  const id = insertSpirit();
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/inventory/spirits/${id}/enrichment`,
        payload: method === "DELETE" ? undefined : { official: "hacked" }
      });
      assert.equal(res.statusCode, 404, `${method} enrichment must not exist`);
    }
  } finally {
    cleanup(id);
  }
});

test("inventory mutations remain protected without admin authorization", async () => {
  cleanup();
  const id = insertSpirit("Auth Guard Bottle");
  try {
    const create = await app.inject({
      method: "POST",
      url: "/api/inventory/spirits",
      payload: { name: "Unauthorized Add", brand: "X", category: "Rum", abv: 40, volume_ml: 750 }
    });
    assert.equal(create.statusCode, 401);
    assert.equal((create.json() as { error: string }).error, "Admin session required");

    const update = await app.inject({
      method: "PUT",
      url: `/api/inventory/spirits/${id}`,
      payload: { name: "Hacked Name" }
    });
    assert.equal(update.statusCode, 401);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/inventory/spirits/${id}`
    });
    assert.equal(del.statusCode, 401);

    const row = db.prepare("SELECT name FROM spirits WHERE id=?").get(id) as { name: string };
    assert.equal(row.name, "Auth Guard Bottle", "unauthorized PUT must not mutate");
  } finally {
    cleanup(id);
  }
});

test("authorized keeper can mutate inventory; enrichment stays readable", async () => {
  cleanup();
  const token = createTestAdminToken();
  assert.equal(isAdmin(`Bearer ${token}`, sessionSecret), true);

  const create = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Auth Keeper Bottle",
      brand: "Keeper",
      category: "Bourbon",
      abv: 45,
      volume_ml: 750,
      upc: UPC
    }
  });
  assert.equal(create.statusCode, 201);
  const created = create.json() as { id: number; name: string };
  assert.equal(created.name, "Auth Keeper Bottle");

  try {
    const enrichment = await app.inject({
      method: "GET",
      url: `/api/inventory/spirits/${created.id}/enrichment`
    });
    assert.equal(enrichment.statusCode, 200);

    const update = await app.inject({
      method: "PUT",
      url: `/api/inventory/spirits/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: "Updated by keeper" }
    });
    assert.equal(update.statusCode, 200);
    assert.equal((update.json() as { notes: string }).notes, "Updated by keeper");
  } finally {
    await app.inject({
      method: "DELETE",
      url: `/api/inventory/spirits/${created.id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    cleanup();
  }
});

test("Nick PIN unlock and ADMIN_PIN recovery continue to work", async () => {
  cleanup();
  setPin("4242");
  assert.equal(verifyPin("4242"), true);
  assert.equal(pinAccepted("4242"), true);
  assert.equal(pinAccepted("0000"), false);

  const bad = await app.inject({
    method: "POST",
    url: "/api/auth/unlock",
    payload: { pin: "0000" }
  });
  assert.equal(bad.statusCode, 401);
  assert.equal((bad.json() as { error: string }).error, "Incorrect PIN");

  const good = await app.inject({
    method: "POST",
    url: "/api/auth/unlock",
    payload: { pin: "4242" }
  });
  assert.equal(good.statusCode, 200);
  const unlocked = good.json() as { token: string };
  assert.ok(unlocked.token);
  assert.equal(isAdmin(`Bearer ${unlocked.token}`, sessionSecret), true);

  process.env.ADMIN_PIN = "9999";
  assert.equal(pinAccepted("9999"), true, "env ADMIN_PIN remains a recovery path");
  const adminUnlock = await app.inject({
    method: "POST",
    url: "/api/auth/unlock",
    payload: { pin: "9999" }
  });
  assert.equal(adminUnlock.statusCode, 200);

  const changeDenied = await app.inject({
    method: "POST",
    url: "/api/auth/pin",
    payload: { currentPin: "4242", newPin: "5555" }
  });
  assert.equal(changeDenied.statusCode, 401, "PIN change requires admin session");

  const change = await app.inject({
    method: "POST",
    url: "/api/auth/pin",
    headers: { authorization: `Bearer ${unlocked.token}` },
    payload: { currentPin: "4242", newPin: "5555" }
  });
  assert.equal(change.statusCode, 200);
  assert.equal(verifyPin("5555"), true);
  assert.equal(verifyPin("4242"), false);

  const house = await app.inject({ method: "GET", url: "/api/house" });
  assert.equal(house.statusCode, 200);
  const houseBody = JSON.stringify(house.json());
  assert.equal(houseBody.includes("pinHash"), false);
  assert.equal(houseBody.includes("4242"), false);
  assert.equal(houseBody.includes("5555"), false);
  assert.equal(houseBody.includes("9999"), false);

  cleanup();
});

test("expired or forged admin tokens cannot mutate inventory", async () => {
  cleanup();
  const id = insertSpirit("Auth Token Bottle");
  try {
    const expired = createAdminToken(sessionSecret, Date.now() - 60_000);
    const forged = "not.a.token";
    for (const token of [expired, forged, ""]) {
      const res = await app.inject({
        method: "PUT",
        url: `/api/inventory/spirits/${id}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: { name: "Should Fail" }
      });
      assert.equal(res.statusCode, 401);
    }
    const row = db.prepare("SELECT name FROM spirits WHERE id=?").get(id) as { name: string };
    assert.equal(row.name, "Auth Token Bottle");
  } finally {
    cleanup(id);
  }
});
