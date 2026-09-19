/**
 * Phase 1 — Guest AI cocktail saves expire; Keeper saves stay permanent.
 * Expiration is enforced by the database read path, not the client.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createAdminToken } from "./auth.js";
import { sqliteUtc } from "./cocktail_expiry.js";
import { db } from "./db.js";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app, createTestAdminToken, sessionSecret } = await import("./server.js");

type CocktailRow = {
  id: number;
  name: string;
  collection: string;
  method: string;
  ingredients: string;
  expires_at: string | null;
  image_url: string;
  source_url: string;
  bartender_fav: number;
};

function wipe() {
  db.prepare("DELETE FROM cocktails WHERE name LIKE 'TmpGuest-%'").run();
}

after(wipe);

function recipe(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    ingredients: ["45 ml bourbon", "1 sugar cube"],
    method: "Stir over ice.",
    glassware: "Rocks",
    garnish: "Orange peel",
    season: "Fall",
    notes: "Smoky and short.",
    ...extra
  };
}

function rowByName(name: string) {
  return db.prepare("SELECT * FROM cocktails WHERE name=?").get(name) as CocktailRow | undefined;
}

function hoursUntil(stamp: string) {
  return (Date.parse(`${stamp.replace(" ", "T")}Z`) - Date.now()) / 3_600_000;
}

async function saveGenerated(name: string, extra: Record<string, unknown> = {}, token?: string) {
  return app.inject({
    method: "POST",
    url: "/api/cocktails/generated",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: recipe(name, extra)
  });
}

test("Keeper AI save creates a permanent cocktail", async () => {
  wipe();
  const res = await saveGenerated("TmpGuest-keeper", {}, createTestAdminToken());
  assert.equal(res.statusCode, 201);
  const body = res.json() as { temporary: boolean; cocktail: CocktailRow };
  assert.equal(body.temporary, false);
  assert.equal(body.cocktail.expires_at, null);
  assert.equal(body.cocktail.collection, "Custom Cocktails");
  const row = rowByName("TmpGuest-keeper");
  assert.equal(row?.expires_at, null);
  assert.equal(row?.collection, "Custom Cocktails");
  assert.equal(row?.bartender_fav, 0);
  assert.equal(row?.image_url, "");
  assert.equal(row?.source_url, "");
});

test("Guest AI save expires about 24 hours later and hides the timestamp", async () => {
  wipe();
  const res = await saveGenerated("TmpGuest-guest");
  assert.equal(res.statusCode, 201);
  const body = res.json() as { temporary: boolean; cocktail: Record<string, unknown> };
  assert.equal(body.temporary, true);
  assert.equal("expires_at" in body.cocktail, false);
  assert.equal(body.cocktail.collection, "Custom Cocktails");
  const row = rowByName("TmpGuest-guest");
  assert.ok(row?.expires_at);
  const hours = hoursUntil(row.expires_at);
  assert.ok(hours > 23.5 && hours < 24.5, `expected ~24h, got ${hours}`);
  assert.equal(row.bartender_fav, 0);
  assert.equal(row.image_url, "");
  assert.equal(row.source_url, "");
});

test("a forged Keeper token is rejected and inserts nothing", async () => {
  wipe();
  const forged = await saveGenerated("TmpGuest-forged", {}, createAdminToken("not-the-session-secret"));
  assert.equal(forged.statusCode, 401);
  assert.equal((forged.json() as { error: string }).error, "Keeper session expired or invalid");
  assert.equal(rowByName("TmpGuest-forged"), undefined);
});

test("an expired Keeper token is rejected and inserts nothing", async () => {
  wipe();
  const expired = await saveGenerated("TmpGuest-expired", {}, createAdminToken(sessionSecret, Date.now() - 1_000));
  assert.equal(expired.statusCode, 401);
  assert.equal((expired.json() as { error: string }).error, "Keeper session expired or invalid");
  assert.equal(rowByName("TmpGuest-expired"), undefined);
});

test("Guest-provided expiration, collection, and keeper fields are rejected", async () => {
  wipe();
  const forbidden = {
    id: 1,
    collection: "IBA Classics",
    expires_at: null,
    bartender_fav: 1,
    image_url: "https://example.invalid/photo.jpg",
    source_url: "https://example.invalid/recipe"
  };
  const res = await saveGenerated("TmpGuest-fields", forbidden);
  assert.equal(res.statusCode, 400);
  assert.equal(rowByName("TmpGuest-fields"), undefined);
  const negroni = rowByName("Negroni");
  assert.ok(negroni);
  assert.notEqual(negroni.collection, "Custom Cocktails");
});

test("Guest cannot force a permanent save by omitting or nulling expires_at", async () => {
  wipe();
  const nulled = await saveGenerated("TmpGuest-null-exp", { expires_at: null });
  assert.equal(nulled.statusCode, 400);
  assert.equal(rowByName("TmpGuest-null-exp"), undefined);

  const far = await saveGenerated("TmpGuest-far-exp", { expires_at: "2999-01-01 00:00:00" });
  assert.equal(far.statusCode, 400);

  const plain = await saveGenerated("TmpGuest-plain");
  assert.equal(plain.statusCode, 201);
  const row = rowByName("TmpGuest-plain");
  assert.ok(row?.expires_at);
  assert.ok(hoursUntil(row.expires_at) < 25);
});

test("Guest cannot update an existing cocktail through the generated route", async () => {
  wipe();
  const before = rowByName("Negroni");
  assert.ok(before);
  const res = await saveGenerated("Negroni", { method: "Do not overwrite the house Negroni." });
  assert.equal(res.statusCode, 409);
  const after = rowByName("Negroni");
  assert.equal(after?.method, before.method);
  assert.equal(after?.id, before.id);
  assert.equal(after?.expires_at ?? null, before.expires_at ?? null);

  const byId = await saveGenerated("TmpGuest-by-id", { id: before.id });
  assert.equal(byId.statusCode, 400);
  assert.equal(rowByName("Negroni")?.method, before.method);
  assert.equal(rowByName("TmpGuest-by-id"), undefined);

  const keeper = await saveGenerated("Negroni", { method: "Keeper must not upsert here." }, createTestAdminToken());
  assert.equal(keeper.statusCode, 409);
  assert.equal(rowByName("Negroni")?.method, before.method);
});

test("unexpired temporary cocktails appear and expired ones do not", async () => {
  wipe();
  const soon = sqliteUtc(new Date(Date.now() + 2 * 3_600_000));
  const past = sqliteUtc(new Date(Date.now() - 2 * 3_600_000));
  db.prepare(`INSERT INTO cocktails(name, collection, ingredients, method, expires_at)
    VALUES ('TmpGuest-live', 'Custom Cocktails', '["30 ml gin"]', 'Stir', ?)`).run(soon);
  db.prepare(`INSERT INTO cocktails(name, collection, ingredients, method, expires_at)
    VALUES ('TmpGuest-dead', 'Custom Cocktails', '["30 ml gin"]', 'Stir', ?)`).run(past);

  const match = await app.inject({ method: "GET", url: "/api/cocktails/match" });
  assert.equal(match.statusCode, 200);
  const names = (match.json() as Array<{ name: string }>).map((drink) => drink.name);
  assert.ok(names.includes("TmpGuest-live"));
  assert.equal(names.includes("TmpGuest-dead"), false);
  assert.ok(names.includes("Old Fashioned"));
  const classic = (match.json() as Array<{ name: string; expires_at: string | null }>).find((drink) => drink.name === "Old Fashioned");
  assert.equal(classic?.expires_at ?? null, null);

  const inventory = await app.inject({ method: "GET", url: "/api/inventory/cocktails" });
  const inventoryNames = (inventory.json() as Array<{ name: string }>).map((drink) => drink.name);
  assert.ok(inventoryNames.includes("TmpGuest-live"));
  assert.equal(inventoryNames.includes("TmpGuest-dead"), false);
});

test("cleanup removes expired temporary rows and never permanent cocktails", async () => {
  wipe();
  const permanentBefore = (db.prepare("SELECT COUNT(*) AS c FROM cocktails WHERE expires_at IS NULL").get() as { c: number }).c;
  db.prepare(`INSERT INTO cocktails(name, collection, ingredients, method, expires_at)
    VALUES ('TmpGuest-keep', 'Custom Cocktails', '["30 ml gin"]', 'Stir', NULL)`).run();
  db.prepare(`INSERT INTO cocktails(name, collection, ingredients, method, expires_at)
    VALUES ('TmpGuest-stale', 'Custom Cocktails', '["30 ml gin"]', 'Stir', ?)`).run(sqliteUtc(new Date(Date.now() - 60_000)));

  const match = await app.inject({ method: "GET", url: "/api/cocktails/match" });
  assert.equal(match.statusCode, 200);
  assert.ok(rowByName("TmpGuest-keep"));
  assert.equal(rowByName("TmpGuest-keep")?.expires_at, null);
  assert.equal(rowByName("TmpGuest-stale"), undefined);
  assert.ok(rowByName("Old Fashioned"));
  const permanentAfter = (db.prepare("SELECT COUNT(*) AS c FROM cocktails WHERE expires_at IS NULL").get() as { c: number }).c;
  assert.equal(permanentAfter, permanentBefore + 1);
});

test("existing Keeper cocktail CRUD stays protected", async () => {
  wipe();
  const negroni = rowByName("Negroni");
  assert.ok(negroni);
  const guestCustom = await app.inject({
    method: "POST",
    url: "/api/cocktails/custom",
    payload: recipe("TmpGuest-via-custom", { expires_at: null, collection: "IBA Classics", bartender_fav: 1, image_url: "https://example.invalid/x.jpg" })
  });
  assert.equal(guestCustom.statusCode, 401);
  assert.equal(rowByName("TmpGuest-via-custom"), undefined);

  const fav = await app.inject({
    method: "PUT",
    url: `/api/cocktails/${negroni.id}`,
    payload: { bartender_fav: 1 }
  });
  assert.equal(fav.statusCode, 401);
  assert.equal(rowByName("Negroni")?.bartender_fav, negroni.bartender_fav);

  const removed = await app.inject({ method: "DELETE", url: `/api/cocktails/${negroni.id}` });
  assert.equal(removed.statusCode, 401);
  assert.ok(rowByName("Negroni"));

  const photo = await app.inject({ method: "POST", url: `/api/cocktails/${negroni.id}/find-image`, payload: {} });
  assert.equal(photo.statusCode, 401);

  const inventory = await app.inject({
    method: "POST",
    url: "/api/inventory/spirits",
    payload: { name: "TmpGuest spirit", category: "Whiskey" }
  });
  assert.equal(inventory.statusCode, 401);

  const token = createTestAdminToken();
  const keeper = await app.inject({
    method: "POST",
    url: "/api/cocktails/custom",
    headers: { authorization: `Bearer ${token}` },
    payload: recipe("TmpGuest-keeper-custom")
  });
  assert.equal(keeper.statusCode, 201);
  assert.equal(rowByName("TmpGuest-keeper-custom")?.expires_at ?? null, null);
});
