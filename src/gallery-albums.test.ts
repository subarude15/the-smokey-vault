/**
 * PR132 — Gallery albums for parties and special nights.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const {
  createGalleryAlbum,
  deleteGalleryAlbum,
  ensureDefaultGalleryAlbum,
  galleryDir,
  listGallery,
  listGalleryAlbums,
  moveGalleryMedia,
  renameGalleryAlbum,
  saveGalleryUpload
} = await import("./gallery.js");
const {
  albumMemoryLabel,
  defaultAlbumId,
  sortAlbumsForDisplay
} = await import("../client/src/gallery-albums.ts");
const { GENERAL_GALLERY_ALBUM_NAME } = await import("./speakeasy-shared.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

function cleanupGallery() {
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare("DELETE FROM gallery_albums").run();
  ensureDefaultGalleryAlbum();
}

test("ensureDefaultGalleryAlbum creates General once and migrates orphan media", () => {
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare("DELETE FROM gallery_albums").run();

  // Simulate legacy media with no album before migration helpers run.
  db.prepare(
    "INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id) VALUES(?,?,?,?,NULL)"
  ).run("legacy.jpg", "image", "old night", "Patron");

  const first = ensureDefaultGalleryAlbum();
  assert.equal(first.name, GENERAL_GALLERY_ALBUM_NAME);
  assert.equal(first.is_default, 1);
  const orphan = db.prepare("SELECT album_id FROM gallery_media WHERE filename=?").get("legacy.jpg") as { album_id: number };
  assert.equal(orphan.album_id, first.id);

  const second = ensureDefaultGalleryAlbum();
  assert.equal(second.id, first.id);
  const defaults = db.prepare("SELECT COUNT(*) AS c FROM gallery_albums WHERE is_default=1").get() as { c: number };
  assert.equal(defaults.c, 1);
  const generals = db.prepare(
    "SELECT COUNT(*) AS c FROM gallery_albums WHERE name = ? COLLATE NOCASE"
  ).get(GENERAL_GALLERY_ALBUM_NAME) as { c: number };
  assert.equal(generals.c, 1);
});

test("list albums includes media counts and puts General first", () => {
  cleanupGallery();
  const general = ensureDefaultGalleryAlbum();
  const christmas = createGalleryAlbum({ name: "Christmas" });
  saveGalleryUpload({ buffer: jpeg, contentType: "image/jpeg", albumId: christmas.id });
  saveGalleryUpload({ buffer: Buffer.concat([jpeg, Buffer.from("x")]), contentType: "image/jpeg", albumId: general.id });

  const albums = listGalleryAlbums();
  assert.equal(albums[0].id, general.id);
  assert.equal(albums[0].is_default, 1);
  const party = albums.find((album) => album.id === christmas.id);
  assert.ok(party);
  assert.equal(party.media_count, 1);
  assert.ok(party.cover_url);
});

test("Keeper can create and rename albums; duplicates rejected case-insensitively", async () => {
  cleanupGallery();
  const token = createTestAdminToken();
  const created = await app.inject({
    method: "POST",
    url: "/api/gallery/albums",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "  St. Patrick’s Day  " }
  });
  assert.equal(created.statusCode, 201);
  const album = created.json() as { id: number; name: string };
  assert.equal(album.name, "St. Patrick’s Day");

  const dup = await app.inject({
    method: "POST",
    url: "/api/gallery/albums",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "st. patrick’s day" }
  });
  assert.equal(dup.statusCode, 400);

  const renamed = await app.inject({
    method: "PUT",
    url: `/api/gallery/albums/${album.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Birthday Bash" }
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal((renamed.json() as { name: string }).name, "Birthday Bash");
  assert.equal(renameGalleryAlbum(album.id, { name: "Patio Pour" }).name, "Patio Pour");
});

test("Guest cannot create, rename, or delete albums", async () => {
  cleanupGallery();
  const album = createGalleryAlbum({ name: "Keepers Only" });

  assert.equal((await app.inject({
    method: "POST",
    url: "/api/gallery/albums",
    payload: { name: "Guest Party" }
  })).statusCode, 401);

  assert.equal((await app.inject({
    method: "PUT",
    url: `/api/gallery/albums/${album.id}`,
    payload: { name: "Nope" }
  })).statusCode, 401);

  assert.equal((await app.inject({
    method: "DELETE",
    url: `/api/gallery/albums/${album.id}`
  })).statusCode, 401);

  assert.equal(listGalleryAlbums().some((row) => row.id === album.id), true);
});

test("Guest can list albums and album media", async () => {
  cleanupGallery();
  const album = createGalleryAlbum({ name: "Open House" });
  saveGalleryUpload({ buffer: jpeg, contentType: "image/jpeg", albumId: album.id });

  const albums = await app.inject({ method: "GET", url: "/api/gallery/albums" });
  assert.equal(albums.statusCode, 200);
  assert.ok(((albums.json() as { albums: unknown[] }).albums).length >= 2);

  const media = await app.inject({ method: "GET", url: `/api/gallery?album_id=${album.id}` });
  assert.equal(media.statusCode, 200);
  const body = media.json() as { media: Array<{ album_id: number }> };
  assert.equal(body.media.length, 1);
  assert.equal(body.media[0].album_id, album.id);
});

test("deleting a populated album moves media to General and keeps the file", async () => {
  cleanupGallery();
  const token = createTestAdminToken();
  const album = createGalleryAlbum({ name: "Temporary" });
  const media = saveGalleryUpload({
    buffer: Buffer.concat([jpeg, Buffer.from("temp")]),
    contentType: "image/jpeg",
    albumId: album.id
  });
  const path = join(galleryDir, media.filename);
  assert.equal(existsSync(path), true);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/gallery/albums/${album.id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(deleted.statusCode, 200);
  const result = deleted.json() as { moved: number; destination_album_id: number };
  assert.equal(result.moved, 1);

  const general = ensureDefaultGalleryAlbum();
  assert.equal(result.destination_album_id, general.id);
  assert.equal(listGalleryAlbums().some((row) => row.id === album.id), false);
  assert.equal(listGallery(general.id).some((row) => row.id === media.id), true);
  assert.equal(existsSync(path), true);
});

test("General album cannot be deleted", async () => {
  cleanupGallery();
  const token = createTestAdminToken();
  const general = ensureDefaultGalleryAlbum();
  const res = await app.inject({
    method: "DELETE",
    url: `/api/gallery/albums/${general.id}`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(ensureDefaultGalleryAlbum().id, general.id);
  assert.throws(() => deleteGalleryAlbum(general.id), /General album cannot be deleted/);
});

test("upload assigns album_id and invalid album falls back to General", async () => {
  cleanupGallery();
  const album = createGalleryAlbum({ name: "Upload Target" });
  const assigned = saveGalleryUpload({
    buffer: jpeg,
    contentType: "image/jpeg",
    albumId: album.id
  });
  assert.equal(assigned.album_id, album.id);

  const fallback = saveGalleryUpload({
    buffer: Buffer.concat([jpeg, Buffer.from("fb")]),
    contentType: "image/jpeg",
    albumId: 999999
  });
  assert.equal(fallback.album_id, ensureDefaultGalleryAlbum().id);

  const boundary = "----smokeyboundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="album_id"\r\n\r\n${album.id}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="uploaded_by"\r\n\r\nGuest\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nHi\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="shot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
    ),
    Buffer.concat([jpeg, Buffer.from("http")]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const upload = await app.inject({
    method: "POST",
    url: "/api/gallery/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body
  });
  assert.equal(upload.statusCode, 201);
  assert.equal((upload.json() as { album_id: number }).album_id, album.id);
});

test("Keeper can move media between albums without changing the stored file", async () => {
  cleanupGallery();
  const token = createTestAdminToken();
  const a = createGalleryAlbum({ name: "Album A" });
  const b = createGalleryAlbum({ name: "Album B" });
  const media = saveGalleryUpload({
    buffer: Buffer.concat([jpeg, Buffer.from("move")]),
    contentType: "image/jpeg",
    albumId: a.id
  });
  const path = join(galleryDir, media.filename);

  const moved = await app.inject({
    method: "PUT",
    url: `/api/gallery/${media.id}/album`,
    headers: { authorization: `Bearer ${token}` },
    payload: { album_id: b.id }
  });
  assert.equal(moved.statusCode, 200);
  assert.equal((moved.json() as { album_id: number }).album_id, b.id);
  assert.equal(existsSync(path), true);
  assert.equal(listGallery(a.id).some((row) => row.id === media.id), false);
  assert.equal(listGallery(b.id).some((row) => row.id === media.id), true);
  assert.equal(moveGalleryMedia(media.id, a.id).album_id, a.id);

  assert.equal((await app.inject({
    method: "PUT",
    url: `/api/gallery/${media.id}/album`,
    payload: { album_id: b.id }
  })).statusCode, 401);
});

test("client album helpers and Gallery UI wire album selection", () => {
  assert.equal(albumMemoryLabel(0), "0 memories");
  assert.equal(albumMemoryLabel(1), "1 memory");
  assert.equal(albumMemoryLabel(3), "3 memories");

  const sorted = sortAlbumsForDisplay([
    { id: 2, name: "Christmas", is_default: 0, event_id: null, created_at: "", updated_at: "", media_count: 0, cover_url: null },
    { id: 1, name: "General", is_default: 1, event_id: null, created_at: "", updated_at: "", media_count: 0, cover_url: null },
    { id: 3, name: "Birthday", is_default: 0, event_id: null, created_at: "", updated_at: "", media_count: 0, cover_url: null }
  ]);
  assert.deepEqual(sorted.map((album) => album.name), ["General", "Birthday", "Christmas"]);
  assert.equal(defaultAlbumId(sorted), 1);

  const page = readFileSync(join(root, "client/src/GalleryPage.tsx"), "utf8");
  assert.match(page, /\/gallery\/albums/);
  assert.match(page, /album_id/);
  assert.match(page, /New album/);
  assert.match(page, /Move/);
  assert.match(page, /multiple/);
  assert.match(page, /Albums/);
  assert.doesNotMatch(page, /album folders|filesystem folder/i);
});
