/**
 * PR144 — Keeper large-video upload path.
 * Streaming upload, Guest vs Keeper limits (videos only), cleanup, validation, and PR143 poster compatibility.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const {
  GalleryError,
  deleteGalleryMedia,
  ensureDefaultGalleryAlbum,
  galleryDir,
  galleryPosterFilename,
  galleryTmpDir,
  listGallery,
  saveGalleryUploadFromStream,
} = await import("./gallery.js");
const {
  GALLERY_IMAGE_MAX_BYTES,
  GUEST_GALLERY_MAX_BYTES,
  KEEPER_GALLERY_DEFAULT_MAX_MB,
  KEEPER_GALLERY_HARD_CAP_MB,
  KEEPER_GALLERY_MAX_VIDEO_MB_ENV,
  formatGalleryLimit,
  galleryOversizeMessage,
  resolveKeeperGalleryMaxBytes,
} = await import("./speakeasy-shared.js");
const {
  mergeGallerySelections,
  validateGalleryFileSize,
} = await import("../client/src/gallery-upload.ts");

const MB = 1024 * 1024;
/** Valid JPEG magic bytes (sniffs to image/jpeg regardless of declared type/extension). */
const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
/** Minimal ftyp box — recognized as an mp4 video but not decodable, so poster extraction fails. */
const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(64, 3)]);
const sampleMp4 = existsSync("/tmp/sample.mp4") ? readFileSync("/tmp/sample.mp4") : null;

/** Generous limits (both types high) for tests that are not exercising a ceiling. */
const wideLimits = { imageBytes: 10 * MB, videoBytes: 10 * MB, isKeeper: true };

function wipeGallery() {
  db.prepare("DELETE FROM gallery_media").run();
  db.prepare("DELETE FROM gallery_albums").run();
  ensureDefaultGalleryAlbum();
  for (const name of readdirSync(galleryDir)) {
    try {
      unlinkSync(join(galleryDir, name));
    } catch {
      // ignore directories (tmp) and busy files
    }
  }
  clearTmp();
}

function clearTmp() {
  if (!existsSync(galleryTmpDir)) return;
  for (const name of readdirSync(galleryTmpDir)) {
    try {
      unlinkSync(join(galleryTmpDir, name));
    } catch {
      // ignore
    }
  }
}

function tmpPartCount(): number {
  if (!existsSync(galleryTmpDir)) return 0;
  return readdirSync(galleryTmpDir).filter((name) => name.endsWith(".part")).length;
}

function rowCount(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM gallery_media").get() as { c: number }).c;
}

function fromBytes(buffer: Buffer): Readable {
  return Readable.from(buffer);
}

/** A source that yields a valid prefix then errors mid-stream. */
function failingStream(prefix: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(prefix);
      } else {
        this.destroy(new Error("network dropped mid-upload"));
      }
    },
  });
}

/* --------------------------- Limit configuration --------------------------- */

test("resolveKeeperGalleryMaxBytes falls back safely for malformed values", () => {
  const fallback = KEEPER_GALLERY_DEFAULT_MAX_MB * MB;
  for (const bad of [undefined, null, "", "   ", "abc", "-5", "0", "NaN", "Infinity", "1e999", "-1e9"]) {
    assert.equal(resolveKeeperGalleryMaxBytes(bad), fallback, `expected fallback for ${String(bad)}`);
  }
});

test("resolveKeeperGalleryMaxBytes honors valid values within bounds", () => {
  assert.equal(resolveKeeperGalleryMaxBytes("2048"), 2048 * MB);
  assert.equal(resolveKeeperGalleryMaxBytes("500.9"), 500 * MB, "fractional MB floors, does not disable protection");
  // Below the Guest floor clamps up so Keepers never get less than Guests.
  assert.equal(resolveKeeperGalleryMaxBytes("50"), GUEST_GALLERY_MAX_BYTES);
  // Absurdly large clamps to the hard cap.
  assert.equal(resolveKeeperGalleryMaxBytes("9999999"), KEEPER_GALLERY_HARD_CAP_MB * MB);
});

test("formatGalleryLimit renders MB under 1 GB and trimmed GB above", () => {
  assert.equal(formatGalleryLimit(GUEST_GALLERY_MAX_BYTES), "150 MB");
  assert.equal(formatGalleryLimit(1024 * MB), "1 GB");
  assert.equal(formatGalleryLimit(1536 * MB), "1.5 GB");
});

test("galleryOversizeMessage is media-type and role aware, never leaking raw errors", () => {
  assert.match(galleryOversizeMessage({ ceilingBytes: GUEST_GALLERY_MAX_BYTES, isKeeper: false }), /guest upload limit/i);
  assert.match(galleryOversizeMessage({ ceilingBytes: 1024 * MB, isKeeper: true }), /Keeper upload limit/i);
  // Photos share one message regardless of role.
  assert.match(
    galleryOversizeMessage({ ceilingBytes: GALLERY_IMAGE_MAX_BYTES, isKeeper: true, mediaType: "image" }),
    /photo limit/i,
  );
  assert.doesNotMatch(galleryOversizeMessage({ ceilingBytes: 1024 * MB, isKeeper: true }), /FST_|multipart|request entity/i);
});

/* ------------------------------ Streaming path ----------------------------- */

test("large path streams to a temp file and finalizes without buffering the whole upload", async () => {
  wipeGallery();
  const payload = Buffer.concat([jpegMagic, Buffer.alloc(3 * MB, 9)]);
  const media = await saveGalleryUploadFromStream({
    stream: fromBytes(payload),
    limits: wideLimits,
    contentType: "image/jpeg",
    originalName: "big.jpg",
    readFields: () => ({ caption: "Late night", uploadedBy: "Nick", albumId: undefined }),
  });

  assert.equal(media.media_type, "image");
  assert.equal(media.caption, "Late night");
  assert.equal(media.uploaded_by, "Nick");
  assert.ok(existsSync(join(galleryDir, media.filename)), "durable file written");
  assert.equal(statSync(join(galleryDir, media.filename)).size, payload.length, "full bytes streamed to disk");
  assert.equal(tmpPartCount(), 0, "no temp file left behind on success");
  wipeGallery();
});

test("exceeding the ceiling returns 413, removes the temp file, and creates no row", async () => {
  wipeGallery();
  const before = rowCount();
  const limits = { imageBytes: 100, videoBytes: 100, isKeeper: true };
  const expected = galleryOversizeMessage({ ceilingBytes: 100, isKeeper: true, mediaType: "video" });
  await assert.rejects(
    saveGalleryUploadFromStream({
      stream: fromBytes(Buffer.concat([jpegMagic, Buffer.alloc(5000, 1)])),
      limits,
    }),
    (error: unknown) => error instanceof GalleryError && error.status === 413 && error.message === expected,
  );
  assert.equal(tmpPartCount(), 0, "partial temp file removed after over-limit abort");
  assert.equal(rowCount(), before, "no Gallery row created for an over-limit upload");
  wipeGallery();
});

test("a stream that fails mid-upload leaves no temp file and no row", async () => {
  wipeGallery();
  const before = rowCount();
  await assert.rejects(
    saveGalleryUploadFromStream({
      stream: failingStream(Buffer.concat([jpegMagic, Buffer.alloc(2048, 2)])),
      limits: wideLimits,
    }),
    /network dropped mid-upload/,
  );
  assert.equal(tmpPartCount(), 0, "partial temp file removed after stream error");
  assert.equal(rowCount(), before, "no Gallery row created after a failed stream");
  wipeGallery();
});

test("a zero-byte upload is rejected with no row", async () => {
  wipeGallery();
  const before = rowCount();
  await assert.rejects(
    saveGalleryUploadFromStream({ stream: Readable.from([]), limits: wideLimits }),
    (error: unknown) => error instanceof GalleryError && /photo or video/i.test(error.message),
  );
  assert.equal(tmpPartCount(), 0);
  assert.equal(rowCount(), before);
  wipeGallery();
});

test("unsupported media is rejected, temp cleaned, and no row created", async () => {
  wipeGallery();
  const before = rowCount();
  await assert.rejects(
    saveGalleryUploadFromStream({
      stream: fromBytes(Buffer.alloc(4096, 0x42)),
      limits: wideLimits,
      contentType: "application/octet-stream",
      originalName: "notes.bin",
    }),
    (error: unknown) => error instanceof GalleryError && /JPEG|PNG|WebP|MP4/i.test(error.message),
  );
  assert.equal(tmpPartCount(), 0);
  assert.equal(rowCount(), before);
  wipeGallery();
});

test("magic bytes win over a misleading extension and declared type", async () => {
  wipeGallery();
  const media = await saveGalleryUploadFromStream({
    stream: fromBytes(Buffer.concat([jpegMagic, Buffer.alloc(1024, 5)])),
    limits: wideLimits,
    // Lies: claims mp4 by name and header, but the bytes are a JPEG.
    contentType: "video/mp4",
    originalName: "trick.mp4",
  });
  assert.equal(media.media_type, "image");
  assert.match(media.filename, /\.jpg$/);
  wipeGallery();
});

test("album and caption from streamed fields persist", async () => {
  wipeGallery();
  const album = db.prepare("INSERT INTO gallery_albums(name, is_default) VALUES(?, 0)").run("Backyard Bash");
  const albumId = Number(album.lastInsertRowid);
  const media = await saveGalleryUploadFromStream({
    stream: fromBytes(Buffer.concat([jpegMagic, Buffer.alloc(512, 7)])),
    limits: wideLimits,
    contentType: "image/jpeg",
    readFields: () => ({ caption: "Keg #2", uploadedBy: "Guest", albumId }),
  });
  assert.equal(media.album_id, albumId);
  assert.equal(media.caption, "Keg #2");
  wipeGallery();
});

/* -------------------- Videos-only Keeper ceiling (core PR) ------------------ */

test("a Keeper photo above the image ceiling is rejected even with a high video ceiling", async () => {
  wipeGallery();
  const before = rowCount();
  // Image ceiling tiny, video ceiling huge — a photo must still be rejected.
  const limits = { imageBytes: 100, videoBytes: 10 * MB, isKeeper: true };
  await assert.rejects(
    saveGalleryUploadFromStream({
      stream: fromBytes(Buffer.concat([jpegMagic, Buffer.alloc(5000, 1)])),
      limits,
      contentType: "image/jpeg",
      originalName: "huge-photo.jpg",
    }),
    (error: unknown) => error instanceof GalleryError && error.status === 413 && /photo limit/i.test(error.message),
  );
  assert.equal(tmpPartCount(), 0, "temp cleaned after rejected oversize photo");
  assert.equal(rowCount(), before, "no row for an oversize photo");
  wipeGallery();
});

test("a Keeper video above the image ceiling is accepted up to the video ceiling", async () => {
  wipeGallery();
  // Same limits as the photo case: image ceiling tiny, video ceiling huge.
  const limits = { imageBytes: 100, videoBytes: 10 * MB, isKeeper: true };
  const payload = Buffer.concat([fakeMp4, Buffer.alloc(5000, 3)]); // > image ceiling, < video ceiling
  assert.ok(payload.length > limits.imageBytes && payload.length < limits.videoBytes);
  const media = await saveGalleryUploadFromStream({
    stream: fromBytes(payload),
    limits,
    contentType: "video/mp4",
    originalName: "long-clip.mp4",
  });
  assert.equal(media.media_type, "video", "video accepted above the photo ceiling");
  assert.ok(existsSync(join(galleryDir, media.filename)));
  wipeGallery();
});

/* --------------------------- PR143 poster compat --------------------------- */

test("a streamed video with unreadable frames still saves with a null poster (PR143 soft-fail)", async () => {
  wipeGallery();
  const media = await saveGalleryUploadFromStream({
    stream: fromBytes(fakeMp4),
    limits: wideLimits,
    contentType: "video/mp4",
    originalName: "clip.mp4",
  });
  assert.equal(media.media_type, "video");
  assert.equal(media.poster_url, null, "poster failure does not fail the upload");
  assert.ok(existsSync(join(galleryDir, media.filename)), "video still persisted");
  assert.equal(existsSync(join(galleryDir, galleryPosterFilename(media.filename))), false);
  wipeGallery();
});

test("a real streamed video generates a PR143 poster and shared-ref cleanup removes both", async (t) => {
  if (!sampleMp4) {
    t.skip("sample mp4 unavailable");
    return;
  }
  wipeGallery();
  const first = await saveGalleryUploadFromStream({
    stream: fromBytes(sampleMp4),
    limits: wideLimits,
    contentType: "video/mp4",
    originalName: "party.mp4",
    readFields: () => ({ caption: "one" }),
  });
  assert.equal(first.media_type, "video");
  assert.ok(first.poster_url, "poster generated for a real video");
  assert.match(first.poster_url!, /\.poster\.webp$/);

  const videoPath = join(galleryDir, first.filename);
  const posterPath = join(galleryDir, galleryPosterFilename(first.filename));
  assert.ok(existsSync(videoPath));
  assert.ok(existsSync(posterPath));

  // Identical bytes dedup to the same durable file/poster.
  const second = await saveGalleryUploadFromStream({
    stream: fromBytes(sampleMp4),
    limits: wideLimits,
    contentType: "video/mp4",
    originalName: "party.mp4",
    readFields: () => ({ caption: "two" }),
  });
  assert.equal(second.filename, first.filename);

  deleteGalleryMedia(first.id);
  assert.ok(existsSync(videoPath), "shared original remains while another row references it");
  assert.ok(existsSync(posterPath), "shared poster remains");

  deleteGalleryMedia(second.id);
  assert.equal(existsSync(videoPath), false, "original removed with the last reference");
  assert.equal(existsSync(posterPath), false, "poster removed with the last reference");
  wipeGallery();
});

/* ------------------------- Route + auth-based ceiling ----------------------- */

function multipartUpload(fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) {
  const boundary = "----smokeyPr144";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

test("GET /gallery/config caps photos at 150 MB for everyone and raises only the video ceiling for Keepers", async () => {
  const guest = await app.inject({ method: "GET", url: "/api/gallery/config" });
  assert.equal(guest.statusCode, 200);
  const guestBody = guest.json() as { image_max_bytes: number; video_max_bytes: number; is_keeper: boolean };
  assert.equal(guestBody.image_max_bytes, GALLERY_IMAGE_MAX_BYTES);
  assert.equal(guestBody.video_max_bytes, GUEST_GALLERY_MAX_BYTES);
  assert.equal(guestBody.is_keeper, false);

  const keeper = await app.inject({
    method: "GET",
    url: "/api/gallery/config",
    headers: { authorization: `Bearer ${createTestAdminToken()}` },
  });
  assert.equal(keeper.statusCode, 200);
  const keeperBody = keeper.json() as { image_max_bytes: number; video_max_bytes: number; is_keeper: boolean };
  assert.equal(keeperBody.is_keeper, true);
  assert.equal(keeperBody.image_max_bytes, GALLERY_IMAGE_MAX_BYTES, "photos stay at 150 MB for Keepers too");
  assert.equal(keeperBody.video_max_bytes, resolveKeeperGalleryMaxBytes(process.env[KEEPER_GALLERY_MAX_VIDEO_MB_ENV]));
  assert.ok(keeperBody.video_max_bytes > keeperBody.image_max_bytes, "only the video ceiling is raised");
});

test("guest upload within the Guest limit succeeds over HTTP", async () => {
  wipeGallery();
  const { boundary, body } = multipartUpload(
    { uploaded_by: "Guest", caption: "cheers" },
    { name: "shot.jpg", type: "image/jpeg", bytes: Buffer.concat([jpegMagic, Buffer.from("guest-http")]) },
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/gallery/upload",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(res.statusCode, 201, res.body);
  const media = res.json() as { media_type: string; caption: string };
  assert.equal(media.media_type, "image");
  assert.equal(media.caption, "cheers");
  wipeGallery();
});

test("keeper upload succeeds over HTTP and persists", async () => {
  wipeGallery();
  const { boundary, body } = multipartUpload(
    { uploaded_by: "Nick", caption: "keeper" },
    { name: "keeper.jpg", type: "image/jpeg", bytes: Buffer.concat([jpegMagic, Buffer.from("keeper-http")]) },
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/gallery/upload",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${createTestAdminToken()}`,
    },
    payload: body,
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(listGallery().length, 1);
  wipeGallery();
});

/* --------------------------- No in-memory buffering ------------------------- */

test("the gallery upload path holds no reachable toBuffer() call", () => {
  const gallerySource = readFileSync(new URL("./gallery.ts", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(gallerySource, /\.toBuffer\(/, "gallery persistence must not buffer whole uploads");
  // The upload route must stream; it should not call file.toBuffer().
  const uploadRoute = serverSource.slice(serverSource.indexOf('"/api/gallery/upload"'));
  assert.doesNotMatch(uploadRoute.slice(0, 1200), /toBuffer/);
});

/* ---------------------- Frontend Guest vs Keeper ceilings ------------------- */

function fakeFile(name: string, size: number, type = "video/mp4"): File {
  const file = new File([Buffer.alloc(Math.min(size, 8))], name, { type, lastModified: 1 });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

test("frontend rejects a Keeper photo over 150 MB while accepting a Keeper video over 150 MB", () => {
  const limits = { imageBytes: GUEST_GALLERY_MAX_BYTES, videoBytes: 1024 * MB };
  const bigPhoto = fakeFile("panorama.jpg", 300 * MB, "image/jpeg");
  const bigVideo = fakeFile("night.mp4", 300 * MB, "video/mp4");

  const batch = mergeGallerySelections([], [bigPhoto, bigVideo], limits, (() => {
    let n = 0;
    return () => `id-${++n}`;
  })());

  const photoRow = batch.find((item) => item.file.name === "panorama.jpg");
  const videoRow = batch.find((item) => item.file.name === "night.mp4");
  assert.equal(photoRow?.status, "rejected", "300 MB photo exceeds the 150 MB photo ceiling");
  assert.match(photoRow?.error ?? "", /150 MB/);
  assert.equal(videoRow?.status, "pending", "300 MB video is under the 1 GB Keeper video ceiling");
});

test("frontend Guest ceilings reject a large video that a Keeper could upload", () => {
  const guestLimits = { imageBytes: GUEST_GALLERY_MAX_BYTES, videoBytes: GUEST_GALLERY_MAX_BYTES };
  const keeperLimits = { imageBytes: GUEST_GALLERY_MAX_BYTES, videoBytes: 1024 * MB };
  const bigVideo = fakeFile("bash.mp4", 400 * MB, "video/mp4");

  const guestBatch = mergeGallerySelections([], [bigVideo], guestLimits, (() => {
    let n = 0;
    return () => `g-${++n}`;
  })());
  assert.equal(guestBatch[0].status, "rejected");

  const keeperBatch = mergeGallerySelections([], [bigVideo], keeperLimits, (() => {
    let n = 0;
    return () => `k-${++n}`;
  })());
  assert.equal(keeperBatch[0].status, "pending");
});

test("validateGalleryFileSize reports the ceiling it was given", () => {
  const file = fakeFile("clip.mp4", 300 * MB);
  assert.match(validateGalleryFileSize(file, GUEST_GALLERY_MAX_BYTES) ?? "", /limit/i);
  assert.equal(validateGalleryFileSize(file, 1024 * MB), undefined);
});
