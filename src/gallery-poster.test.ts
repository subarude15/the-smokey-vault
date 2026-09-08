/**
 * PR143 — Gallery video poster filename safety, upload wiring, cleanup, covers.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import {
  backfillMissingGalleryPosters,
  deleteGalleryMedia,
  ensureDefaultGalleryAlbum,
  galleryDir,
  galleryPosterFilename,
  listGallery,
  listGalleryAlbums,
  mediaRowToJson,
  saveGalleryUpload,
} from "./gallery.js";
import { generateGalleryVideoPoster } from "./gallery-poster.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
const sampleMp4 = existsSync("/tmp/sample.mp4")
  ? readFileSync("/tmp/sample.mp4")
  : null;

function wipeGallery() {
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare("DELETE FROM gallery_albums").run();
  ensureDefaultGalleryAlbum();
  // Remove leftover media/poster files so filename-based assertions stay deterministic.
  for (const name of readdirSync(galleryDir)) {
    try {
      unlinkSync(join(galleryDir, name));
    } catch {
      // ignore busy/missing files
    }
  }
}

test("galleryPosterFilename derives a safe sibling webp name", () => {
  assert.equal(galleryPosterFilename("abc123.mp4"), "abc123.poster.webp");
  assert.equal(galleryPosterFilename("clip.mov"), "clip.poster.webp");
  assert.throws(() => galleryPosterFilename("../secret.mp4"));
  assert.throws(() => galleryPosterFilename("nested/clip.mp4"));
  assert.throws(() => galleryPosterFilename("bad\\clip.mp4"));
});

test("image uploads do not invent a poster_url", async () => {
  wipeGallery();
  const photo = await saveGalleryUpload({ buffer: jpeg, contentType: "image/jpeg" });
  assert.equal(photo.media_type, "image");
  assert.equal(photo.poster_url, undefined);
  assert.equal(photo.url, `/api/media/gallery/${photo.filename}`);
  assert.equal(photo.download_url, `/api/media/gallery/${photo.filename}/download`);
  wipeGallery();
});

test("broken video bytes still save with a null poster_url", async () => {
  wipeGallery();
  const stub = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(64, 3),
  ]);
  const saved = await saveGalleryUpload({ buffer: stub, contentType: "video/mp4" });
  assert.equal(saved.media_type, "video");
  assert.equal(saved.poster_url, null);
  assert.equal(saved.url, `/api/media/gallery/${saved.filename}`);
  assert.equal(saved.download_url, `/api/media/gallery/${saved.filename}/download`);
  assert.equal(existsSync(join(galleryDir, galleryPosterFilename(saved.filename))), false);
  wipeGallery();
});

test("real mp4 upload writes a durable poster used by list + album cover", async (t) => {
  if (!sampleMp4) {
    t.skip("sample mp4 unavailable");
    return;
  }
  wipeGallery();
  const saved = await saveGalleryUpload({ buffer: sampleMp4, contentType: "video/mp4" });
  assert.equal(saved.media_type, "video");
  assert.ok(saved.poster_url, "poster_url should be present after generation");
  assert.match(saved.poster_url!, /\.poster\.webp$/);
  assert.notEqual(saved.poster_url, saved.url);
  assert.equal(saved.download_url, `/api/media/gallery/${saved.filename}/download`);

  const posterPath = join(galleryDir, galleryPosterFilename(saved.filename));
  assert.ok(existsSync(posterPath));
  assert.ok(existsSync(join(galleryDir, saved.filename)));

  const listed = listGallery();
  assert.equal(listed[0].poster_url, saved.poster_url);

  const albums = listGalleryAlbums();
  const general = albums.find((album) => album.is_default === 1);
  assert.ok(general);
  assert.equal(general!.cover_url, saved.poster_url);

  wipeGallery();
});

test("deleting the last video row removes original and poster; shared refs keep both", async (t) => {
  if (!sampleMp4) {
    t.skip("sample mp4 unavailable");
    return;
  }
  wipeGallery();
  const first = await saveGalleryUpload({ buffer: sampleMp4, contentType: "video/mp4", caption: "one" });
  const second = await saveGalleryUpload({ buffer: sampleMp4, contentType: "video/mp4", caption: "two" });
  assert.equal(first.filename, second.filename);
  const videoPath = join(galleryDir, first.filename);
  const posterPath = join(galleryDir, galleryPosterFilename(first.filename));
  assert.ok(existsSync(videoPath));
  assert.ok(existsSync(posterPath));

  deleteGalleryMedia(first.id);
  assert.ok(existsSync(videoPath), "shared original remains");
  assert.ok(existsSync(posterPath), "shared poster remains");

  deleteGalleryMedia(second.id);
  assert.equal(existsSync(videoPath), false);
  assert.equal(existsSync(posterPath), false);
  wipeGallery();
});

test("album cover falls back gracefully when a video poster is missing", () => {
  wipeGallery();
  const album = ensureDefaultGalleryAlbum();
  const filename = "legacycover.mp4";
  writeFileSync(join(galleryDir, filename), Buffer.from("not-a-real-video"));
  const result = db
    .prepare(
      `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
       VALUES(?,?,?,?,?)`,
    )
    .run(filename, "video", "legacy", "Patron", album.id);
  const row = db
    .prepare("SELECT id, filename, media_type, caption, uploaded_by, album_id, created_at FROM gallery_media WHERE id=?")
    .get(result.lastInsertRowid) as {
    id: number;
    filename: string;
    media_type: string;
    caption: string;
    uploaded_by: string;
    album_id: number;
    created_at: string;
  };
  const json = mediaRowToJson(row);
  assert.equal(json.poster_url, null);

  const cover = listGalleryAlbums().find((item) => item.id === album.id);
  assert.equal(cover?.cover_url, null);
  wipeGallery();
});

test("backfill generates a missing poster once without touching images", async (t) => {
  if (!sampleMp4) {
    t.skip("sample mp4 unavailable");
    return;
  }
  wipeGallery();
  const album = ensureDefaultGalleryAlbum();
  const hashName = "backfilldemo.mp4";
  writeFileSync(join(galleryDir, hashName), sampleMp4);
  db.prepare(
    `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
     VALUES(?,?,?,?,?)`,
  ).run(hashName, "video", "old", "Patron", album.id);

  assert.equal(existsSync(join(galleryDir, galleryPosterFilename(hashName))), false);
  const first = await backfillMissingGalleryPosters({ limit: 10 });
  assert.equal(first.attempted, 1);
  assert.equal(first.generated, 1);
  assert.ok(existsSync(join(galleryDir, galleryPosterFilename(hashName))));

  const second = await backfillMissingGalleryPosters({ limit: 10 });
  assert.equal(second.attempted, 0);
  assert.equal(second.generated, 0);
  wipeGallery();
});

test("backfill skips ahead of complete early rows so later missing posters are not starved", async (t) => {
  if (!sampleMp4) {
    t.skip("sample mp4 unavailable");
    return;
  }
  wipeGallery();
  const album = ensureDefaultGalleryAlbum();
  const limit = 3;
  const insert = db.prepare(
    `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
     VALUES(?,?,?,?,?)`,
  );

  for (let i = 0; i < limit; i++) {
    const filename = `early${i}.mp4`;
    writeFileSync(join(galleryDir, filename), Buffer.from(`early-video-${i}`));
    writeFileSync(join(galleryDir, galleryPosterFilename(filename)), Buffer.from("fake-poster"));
    insert.run(filename, "video", `early ${i}`, "Patron", album.id);
  }

  const lateName = "latemissing.mp4";
  writeFileSync(join(galleryDir, lateName), sampleMp4);
  insert.run(lateName, "video", "late", "Patron", album.id);
  assert.equal(existsSync(join(galleryDir, galleryPosterFilename(lateName))), false);

  const result = await backfillMissingGalleryPosters({ limit });
  assert.equal(result.attempted, 1);
  assert.equal(result.generated, 1);
  assert.ok(
    existsSync(join(galleryDir, galleryPosterFilename(lateName))),
    "later missing poster must be generated even when earlier rows already have posters",
  );
  wipeGallery();
});

test("backfill does no work when every video already has a poster", async () => {
  wipeGallery();
  const album = ensureDefaultGalleryAlbum();
  for (let i = 0; i < 5; i++) {
    const filename = `complete${i}.mp4`;
    writeFileSync(join(galleryDir, filename), Buffer.from(`video-${i}`));
    writeFileSync(join(galleryDir, galleryPosterFilename(filename)), Buffer.from("poster"));
    db.prepare(
      `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
       VALUES(?,?,?,?,?)`,
    ).run(filename, "video", `done ${i}`, "Patron", album.id);
  }

  const result = await backfillMissingGalleryPosters({ limit: 3 });
  assert.equal(result.attempted, 0);
  assert.equal(result.generated, 0);
  wipeGallery();
});

test("backfill skips missing source files and invalid filenames without counting them", async () => {
  wipeGallery();
  const album = ensureDefaultGalleryAlbum();
  db.prepare(
    `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
     VALUES(?,?,?,?,?)`,
  ).run("ghost.mp4", "video", "missing file", "Patron", album.id);
  // Bypass galleryPosterFilename guards by inserting a path-like name directly.
  db.prepare(
    `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
     VALUES(?,?,?,?,?)`,
  ).run("../escape.mp4", "video", "unsafe", "Patron", album.id);

  const result = await backfillMissingGalleryPosters({ limit: 10 });
  assert.equal(result.attempted, 0);
  assert.equal(result.generated, 0);
  wipeGallery();
});

test("backfill remains bounded even when many posters are missing", async (t) => {
  if (!sampleMp4) {
    t.skip("sample mp4 unavailable");
    return;
  }
  wipeGallery();
  const album = ensureDefaultGalleryAlbum();
  const limit = 2;
  for (let i = 0; i < 5; i++) {
    const filename = `needposter${i}.mp4`;
    writeFileSync(join(galleryDir, filename), sampleMp4);
    db.prepare(
      `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
       VALUES(?,?,?,?,?)`,
    ).run(filename, "video", `need ${i}`, "Patron", album.id);
  }

  const result = await backfillMissingGalleryPosters({ limit });
  assert.equal(result.attempted, limit);
  assert.ok(result.generated <= limit);
  assert.equal(result.generated, limit);

  let posters = 0;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(galleryDir, galleryPosterFilename(`needposter${i}.mp4`)))) posters += 1;
  }
  assert.equal(posters, limit);
  wipeGallery();
});

test("Gallery grid uses poster images instead of embedding video sources", () => {
  const page = readFileSync(join(root, "client/src/GalleryPage.tsx"), "utf8");
  assert.match(page, /item\.poster_url/);
  assert.doesNotMatch(
    page,
    /gallery-open[\s\S]{0,500}<video[^>]*src=\{item\.url\}/,
  );
  assert.match(page, /<video[^>]*src=\{active\.url\}/);
});

test("generateGalleryVideoPoster refuses path traversal filenames", async () => {
  const ok = await generateGalleryVideoPoster({
    galleryDir,
    videoFilename: "../escape.mp4",
  });
  assert.equal(ok, false);
});
