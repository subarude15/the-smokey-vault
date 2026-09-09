/**
 * PR146 — Gallery comments + up/down voting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken, sessionSecret } = await import("./server.js");
const { db } = await import("./db.js");
const {
  addGalleryComment,
  castGalleryVote,
  deleteGallerySocialForMedia,
  deriveGalleryVoterKey,
  galleryVoteTally,
  getGallerySocial,
  listGalleryComments,
  MAX_GALLERY_COMMENT
} = await import("./gallery-social.js");
const { deleteGalleryMedia, moveGalleryMedia, ensureDefaultGalleryAlbum, createGalleryAlbum } = await import("./gallery.js");

let seq = 0;
function insertMedia(type: "image" | "video" = "image"): number {
  seq += 1;
  const result = db.prepare(
    "INSERT INTO gallery_media(filename, media_type, caption, uploaded_by) VALUES(?,?,?,?)"
  ).run(`pr146-${Date.now()}-${seq}.jpg`, type, "", "Patron");
  return Number(result.lastInsertRowid);
}

function auth(token = createTestAdminToken()) {
  return { authorization: `Bearer ${token}` };
}

/* -------------------------------- Comments -------------------------------- */

test("Guest can create a valid comment; response omits internal voter key", async () => {
  const id = insertMedia();
  const res = await app.inject({
    method: "POST",
    url: `/api/gallery/${id}/comments`,
    payload: { body: "  Great night!  ", author: "  Sam  ", voter: "device-guest-1" }
  });
  assert.equal(res.statusCode, 201, res.body);
  const comment = res.json() as Record<string, unknown>;
  assert.equal(comment.body, "Great night!");
  assert.equal(comment.author, "Sam");
  assert.equal(comment.media_id, id);
  assert.ok(typeof comment.created_at === "string");
  // Only the guest-safe fields are serialized.
  assert.deepEqual(Object.keys(comment).sort(), ["author", "body", "created_at", "id", "media_id"]);
  assert.equal("voter_key" in comment, false);
});

test("Empty and whitespace-only comments are rejected", async () => {
  const id = insertMedia();
  for (const body of ["", "   ", "\n\t "]) {
    const res = await app.inject({ method: "POST", url: `/api/gallery/${id}/comments`, payload: { body } });
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(body)} -> ${res.body}`);
  }
  assert.equal(listGalleryComments(id).length, 0);
});

test("Over-length comments are rejected server-side", async () => {
  const id = insertMedia();
  const res = await app.inject({
    method: "POST",
    url: `/api/gallery/${id}/comments`,
    payload: { body: "x".repeat(MAX_GALLERY_COMMENT + 1) }
  });
  assert.equal(res.statusCode, 400, res.body);
  // Exactly at the limit is accepted.
  const ok = await app.inject({
    method: "POST",
    url: `/api/gallery/${id}/comments`,
    payload: { body: "x".repeat(MAX_GALLERY_COMMENT) }
  });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("Missing author defaults to Patron", async () => {
  const id = insertMedia();
  const res = await app.inject({ method: "POST", url: `/api/gallery/${id}/comments`, payload: { body: "hi" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as { author: string }).author, "Patron");
});

test("HTML/script-like content is stored and returned as plain text (never transformed)", async () => {
  const id = insertMedia();
  const nasty = `<script>alert('x')</script> <b>bold</b> & "quotes"`;
  const res = await app.inject({ method: "POST", url: `/api/gallery/${id}/comments`, payload: { body: nasty } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((res.json() as { body: string }).body, nasty);
  // Round-trips verbatim through the read path; rendering escapes it (React text node).
  const social = await app.inject({ method: "GET", url: `/api/gallery/${id}/social` });
  const comments = (social.json() as { comments: Array<{ body: string }> }).comments;
  assert.equal(comments[0].body, nasty);
});

test("Guests cannot delete comments; Keeper can", async () => {
  const id = insertMedia();
  const comment = addGalleryComment(id, { body: "delete me" });

  const guest = await app.inject({ method: "DELETE", url: `/api/gallery/${id}/comments/${comment.id}` });
  assert.equal(guest.statusCode, 401, guest.body);
  assert.equal(listGalleryComments(id).length, 1);

  const keeper = await app.inject({ method: "DELETE", url: `/api/gallery/${id}/comments/${comment.id}`, headers: auth() });
  assert.equal(keeper.statusCode, 204, keeper.body);
  assert.equal(listGalleryComments(id).length, 0);
});

test("Comment deletion is scoped to its media item and does not touch others", async () => {
  const a = insertMedia();
  const b = insertMedia();
  const onA = addGalleryComment(a, { body: "on A" });
  const onB = addGalleryComment(b, { body: "on B" });

  // A comment only appears under its own media.
  assert.equal(listGalleryComments(a).map((c) => c.id).includes(onB.id), false);

  // Deleting with the wrong media id is a no-op (404), comment survives.
  const wrong = await app.inject({ method: "DELETE", url: `/api/gallery/${b}/comments/${onA.id}`, headers: auth() });
  assert.equal(wrong.statusCode, 404, wrong.body);
  assert.equal(listGalleryComments(a).length, 1);

  // Deleting onA leaves onB intact.
  const ok = await app.inject({ method: "DELETE", url: `/api/gallery/${a}/comments/${onA.id}`, headers: auth() });
  assert.equal(ok.statusCode, 204);
  assert.equal(listGalleryComments(a).length, 0);
  assert.equal(listGalleryComments(b).length, 1);
});

test("Deleting media cleans up its comments", async () => {
  const id = insertMedia();
  addGalleryComment(id, { body: "one" });
  addGalleryComment(id, { body: "two" });
  assert.equal(listGalleryComments(id).length, 2);
  deleteGalleryMedia(id);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM gallery_comments WHERE media_id=?").get(id) as { c: number }).c,
    0
  );
});

/* --------------------------------- Votes ---------------------------------- */

async function vote(mediaId: number, value: 1 | -1, voter: string) {
  const res = await app.inject({ method: "POST", url: `/api/gallery/${mediaId}/vote`, payload: { value, voter } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { up: number; down: number; net: number; total: number; mine: 1 | -1 | null };
}

test("First up-vote increments the up count", async () => {
  const id = insertMedia();
  const tally = await vote(id, 1, "voter-a");
  assert.equal(tally.up, 1);
  assert.equal(tally.down, 0);
  assert.equal(tally.mine, 1);
});

test("Repeated same vote does not inflate the count (toggles off)", async () => {
  const id = insertMedia();
  await vote(id, 1, "voter-a");
  const second = await vote(id, 1, "voter-a");
  assert.equal(second.up, 0, "second identical vote must not inflate");
  assert.equal(second.mine, null);
  // Only one active row could ever exist per (media, voter); after toggle-off, none.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM gallery_votes WHERE media_id=?").get(id) as { c: number }).c,
    0
  );
});

test("Switching up -> down updates totals without creating a second vote", async () => {
  const id = insertMedia();
  await vote(id, 1, "voter-a");
  const down = await vote(id, -1, "voter-a");
  assert.equal(down.up, 0);
  assert.equal(down.down, 1);
  assert.equal(down.mine, -1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM gallery_votes WHERE media_id=?").get(id) as { c: number }).c,
    1,
    "a direction switch must reuse the single row"
  );
});

test("A device keeps one vote across IP and User-Agent changes", async () => {
  const id = insertMedia();
  const first = await app.inject({
    method: "POST",
    url: `/api/gallery/${id}/vote`,
    headers: { "user-agent": "Chrome/1" },
    remoteAddress: "10.0.0.5",
    payload: { value: 1, voter: "stable-device" }
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((first.json() as { up: number }).up, 1);

  // Same device token, but the LAN IP and browser UA have changed. Re-voting the
  // same direction must toggle the SAME vote off, not create a second voter.
  const second = await app.inject({
    method: "POST",
    url: `/api/gallery/${id}/vote`,
    headers: { "user-agent": "Safari/2" },
    remoteAddress: "192.168.1.99",
    payload: { value: 1, voter: "stable-device" }
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((second.json() as { up: number }).up, 0, "same device must remain one voter across IP/UA changes");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM gallery_votes WHERE media_id=?").get(id) as { c: number }).c,
    0
  );
});

test("Separate anonymous voters vote independently", async () => {
  const id = insertMedia();
  await vote(id, 1, "voter-a");
  const tally = await vote(id, 1, "voter-b");
  assert.equal(tally.up, 2);
  assert.equal(tally.total, 2);
});

test("Votes on one media item do not affect another", async () => {
  const a = insertMedia();
  const b = insertMedia();
  await vote(a, 1, "voter-a");
  await vote(a, 1, "voter-b");
  const tallyB = galleryVoteTally(b);
  assert.equal(tallyB.up, 0);
  assert.equal(tallyB.total, 0);
  assert.equal(galleryVoteTally(a).up, 2);
});

test("Deleting media cleans up its votes", async () => {
  const id = insertMedia();
  await vote(id, 1, "voter-a");
  await vote(id, -1, "voter-b");
  assert.equal(galleryVoteTally(id).total, 2);
  deleteGalleryMedia(id);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM gallery_votes WHERE media_id=?").get(id) as { c: number }).c,
    0
  );
});

test("Invalid vote values are rejected", async () => {
  const id = insertMedia();
  for (const value of [0, 2, -2, "x"]) {
    const res = await app.inject({ method: "POST", url: `/api/gallery/${id}/vote`, payload: { value, voter: "v" } });
    assert.equal(res.statusCode, 400, `value=${value} -> ${res.body}`);
  }
});

/* ------------------------------ Album lifecycle ---------------------------- */

test("Album move does NOT remove comments or votes (social belongs to media)", async () => {
  ensureDefaultGalleryAlbum();
  const id = insertMedia();
  addGalleryComment(id, { body: "keep me across albums" });
  await vote(id, 1, "voter-a");
  const other = createGalleryAlbum({ name: `PR146 Move Album ${Date.now()}` });

  moveGalleryMedia(id, other.id);

  assert.equal(listGalleryComments(id).length, 1, "comment must survive album move");
  assert.equal(galleryVoteTally(id).up, 1, "vote must survive album move");
});

/* -------------------------------- Privacy --------------------------------- */

test("Guest social response exposes only feature data, never voter keys or request context", async () => {
  const id = insertMedia();
  addGalleryComment(id, { body: "hello", author: "Sam" });
  // Cast via HTTP so the response reflects a server-derived voter key.
  await vote(id, 1, "device-secret-token");

  const res = await app.inject({
    method: "GET",
    url: `/api/gallery/${id}/social?voter=device-secret-token`,
    headers: { "user-agent": "SecretAgent/9.9" },
    remoteAddress: "203.0.113.9"
  });
  assert.equal(res.statusCode, 200, res.body);
  // No stored/derived identity or request context leaks into the payload.
  assert.equal(res.body.includes("voter_key"), false);
  assert.equal(res.body.includes("device-secret-token"), false);
  assert.equal(res.body.includes("203.0.113.9"), false);
  assert.equal(res.body.includes("SecretAgent"), false);

  const social = res.json() as { votes: Record<string, unknown>; comments: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(social.votes).sort(), ["down", "mine", "net", "total", "up"]);
  assert.deepEqual(Object.keys(social.comments[0]).sort(), ["author", "body", "created_at", "id", "media_id"]);
  assert.equal(social.votes.mine, 1);
});

test("Keeper-only comment deletion route stays protected", async () => {
  const id = insertMedia();
  const comment = addGalleryComment(id, { body: "guard" });
  const denied = await app.inject({ method: "DELETE", url: `/api/gallery/${id}/comments/${comment.id}` });
  assert.equal(denied.statusCode, 401);
  assert.equal((denied.json() as { error: string }).error, "Admin session required");
});

/* --------------------------- Voter key derivation -------------------------- */

test("deriveGalleryVoterKey is deterministic, opaque, and device-scoped", () => {
  const a1 = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-1", ip: "127.0.0.1", userAgent: "UA" });
  const a2 = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-1", ip: "127.0.0.1", userAgent: "UA" });
  const b = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-2", ip: "127.0.0.1", userAgent: "UA" });
  assert.equal(a1, a2, "same context yields the same key");
  assert.notEqual(a1, b, "different device tokens yield different keys");
  // Opaque HMAC: never the raw device token, fixed hex length.
  assert.equal(a1.includes("dev-1"), false);
  assert.match(a1, /^[0-9a-f]{64}$/);
});

test("A device token is stable across IP and User-Agent changes", () => {
  const base = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-1", ip: "10.0.0.5", userAgent: "Chrome" });
  const newIp = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-1", ip: "192.168.1.42", userAgent: "Chrome" });
  const newUa = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-1", ip: "10.0.0.5", userAgent: "Safari" });
  const noContext = deriveGalleryVoterKey(sessionSecret, { deviceToken: "dev-1" });
  assert.equal(base, newIp, "same device token + different IP => same key");
  assert.equal(base, newUa, "same device token + different User-Agent => same key");
  assert.equal(base, noContext, "device token alone determines the key");
});

test("No device token falls back deterministically to opaque IP + User-Agent", () => {
  const f1 = deriveGalleryVoterKey(sessionSecret, { ip: "10.0.0.5", userAgent: "Chrome" });
  const f2 = deriveGalleryVoterKey(sessionSecret, { deviceToken: "  ", ip: "10.0.0.5", userAgent: "Chrome" });
  assert.equal(f1, f2, "empty/whitespace device token falls back to request context");
  assert.match(f1, /^[0-9a-f]{64}$/);
  // Opaque: raw context never appears in the key.
  assert.equal(f1.includes("10.0.0.5"), false);
  assert.equal(f1.includes("Chrome"), false);

  // Fallback changes when the fallback context changes.
  assert.notEqual(f1, deriveGalleryVoterKey(sessionSecret, { ip: "10.0.0.6", userAgent: "Chrome" }), "different IP => different fallback key");
  assert.notEqual(f1, deriveGalleryVoterKey(sessionSecret, { ip: "10.0.0.5", userAgent: "Safari" }), "different UA => different fallback key");

  // A device-token key and a fallback key never collide (namespaced material).
  const deviceKey = deriveGalleryVoterKey(sessionSecret, { deviceToken: "10.0.0.5\nChrome" });
  assert.notEqual(deviceKey, f1, "device and fallback namespaces do not collide");
});

test("getGallerySocial returns empty, safe shape for media with no interaction", () => {
  const id = insertMedia();
  const social = getGallerySocial(id);
  assert.deepEqual(social.comments, []);
  assert.deepEqual(social.votes, { up: 0, down: 0, net: 0, total: 0, mine: null });
  deleteGallerySocialForMedia(id);
});
