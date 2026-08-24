import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";
import { createStaff, deleteStaff, listStaff, moveStaff, StaffError, updateStaff } from "./staff.js";
import {
  deleteGalleryMedia, galleryDir, galleryFilePath, GalleryError, listGallery, saveGalleryUpload, sniffGalleryType
} from "./gallery.js";

function wipeCrew() {
  db.prepare("DELETE FROM staff_members").run();
}

function wipeGallery() {
  db.prepare("DELETE FROM gallery_media").run();
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "ascii"), Buffer.alloc(64, 3)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ", "ascii"), Buffer.alloc(64, 4)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 5)]);

test("a new crew member lands at the end of the running order", () => {
  wipeCrew();
  const roo = createStaff({ name: "Roo", role: "Chief Welcome Officer" });
  const nick = createStaff({ name: "Nick", role: "Head Mixologist" });
  assert.equal(roo.display_order, 1);
  assert.equal(nick.display_order, 2);
  assert.deepEqual(listStaff().map((member) => member.name), ["Roo", "Nick"]);
  wipeCrew();
});

test("crew members need a name and clip long bios", () => {
  wipeCrew();
  assert.throws(() => createStaff({ name: "   " }), StaffError);
  const member = createStaff({ name: "Roo", bio: "x".repeat(900) });
  assert.equal(member.bio.length, 600);
  wipeCrew();
});

test("moving a crew member swaps it with its neighbour and stops at the ends", () => {
  wipeCrew();
  createStaff({ name: "First" });
  const middle = createStaff({ name: "Middle" });
  createStaff({ name: "Last" });

  assert.deepEqual(moveStaff(middle.id, "up").map((m) => m.name), ["Middle", "First", "Last"]);
  assert.deepEqual(moveStaff(middle.id, "up").map((m) => m.name), ["Middle", "First", "Last"], "already first");
  assert.deepEqual(moveStaff(middle.id, "down").map((m) => m.name), ["First", "Middle", "Last"]);
  wipeCrew();
});

test("legacy rows sharing display_order still reorder predictably", () => {
  wipeCrew();
  // Rows created before the ordering feature all carry the column default of 0.
  const insert = db.prepare("INSERT INTO staff_members(name, display_order) VALUES(?, 0)");
  insert.run("Alpha");
  insert.run("Beta");
  const target = listStaff()[1];

  const reordered = moveStaff(target.id, "up");
  assert.deepEqual(reordered.map((m) => m.name), ["Beta", "Alpha"]);
  assert.deepEqual(reordered.map((m) => m.display_order), [1, 2], "ordering is normalized");
  wipeCrew();
});

test("editing a crew member leaves untouched fields alone", () => {
  wipeCrew();
  const member = createStaff({ name: "Roo", role: "Cellar Security", bio: "Naps a lot." });
  const updated = updateStaff(member.id, { role: "Chief Welcome Officer" });
  assert.equal(updated.role, "Chief Welcome Officer");
  assert.equal(updated.bio, "Naps a lot.");
  assert.equal(updated.name, "Roo");
  wipeCrew();
});

test("deleting a missing crew member reports it instead of failing silently", () => {
  wipeCrew();
  const member = createStaff({ name: "Roo" });
  assert.deepEqual(deleteStaff(member.id), { ok: true });
  assert.throws(() => deleteStaff(member.id), StaffError);
});

test("gallery sniffing trusts magic bytes over the declared type", () => {
  assert.equal(sniffGalleryType(JPEG), "image/jpeg");
  assert.equal(sniffGalleryType(PNG), "image/png");
  assert.equal(sniffGalleryType(MP4), "video/mp4");
  assert.equal(sniffGalleryType(MOV), "video/quicktime");
  assert.equal(sniffGalleryType(WEBM), "video/webm");
  assert.equal(sniffGalleryType(Buffer.alloc(4)), "");
});

test("an iOS capture sent as octet-stream is still stored as a video", () => {
  wipeGallery();
  const saved = saveGalleryUpload({ buffer: MP4, contentType: "application/octet-stream", originalName: "IMG_0042.MOV" });
  assert.equal(saved.media_type, "video");
  assert.match(saved.filename, /\.mp4$/);
  assert.equal(saved.url, `/api/media/gallery/${saved.filename}`);
  assert.equal(saved.download_url, `/api/media/gallery/${saved.filename}/download`);
  wipeGallery();
});

test("uploads default to Patron and record captions", () => {
  wipeGallery();
  const saved = saveGalleryUpload({ buffer: JPEG, contentType: "image/jpeg", caption: "  Last call  " });
  assert.equal(saved.uploaded_by, "Patron");
  assert.equal(saved.caption, "Last call");
  assert.equal(saved.media_type, "image");

  const named = saveGalleryUpload({ buffer: PNG, contentType: "image/png", uploadedBy: "Dana" });
  assert.equal(named.uploaded_by, "Dana");
  wipeGallery();
});

test("the gallery rejects unsupported files and empty picks", () => {
  assert.throws(() => saveGalleryUpload({ buffer: Buffer.alloc(0) }), GalleryError);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7", "ascii"), Buffer.alloc(64, 1)]);
  assert.throws(() => saveGalleryUpload({ buffer: pdf, contentType: "application/pdf", originalName: "menu.pdf" }), GalleryError);
});

test("the gallery lists newest first", () => {
  wipeGallery();
  const older = saveGalleryUpload({ buffer: JPEG, contentType: "image/jpeg", caption: "older" });
  const newer = saveGalleryUpload({ buffer: PNG, contentType: "image/png", caption: "newer" });
  db.prepare("UPDATE gallery_media SET created_at='2020-01-01 00:00:00' WHERE id=?").run(older.id);

  const listed = listGallery();
  assert.equal(listed[0].id, newer.id);
  assert.equal(listed[listed.length - 1].id, older.id);
  wipeGallery();
});

test("deleting gallery media removes the row and the file on disk", () => {
  wipeGallery();
  const saved = saveGalleryUpload({ buffer: WEBM, contentType: "video/webm" });
  const path = join(galleryDir, saved.filename);
  assert.ok(existsSync(path), "file was written");

  deleteGalleryMedia(saved.id);
  assert.equal(listGallery().length, 0);
  assert.equal(existsSync(path), false, "file was cleaned up");
  assert.throws(() => deleteGalleryMedia(saved.id), GalleryError);
});

test("two rows sharing one file keep the file until the last row goes", () => {
  wipeGallery();
  const first = saveGalleryUpload({ buffer: JPEG, contentType: "image/jpeg", caption: "one" });
  const second = saveGalleryUpload({ buffer: JPEG, contentType: "image/jpeg", caption: "two" });
  assert.equal(first.filename, second.filename, "identical bytes dedupe to one file");
  const path = join(galleryDir, first.filename);

  deleteGalleryMedia(first.id);
  assert.ok(existsSync(path), "still referenced by the second row");
  deleteGalleryMedia(second.id);
  assert.equal(existsSync(path), false);
  wipeGallery();
});

test("gallery paths refuse traversal and missing files", () => {
  assert.throws(() => galleryFilePath("../db.sqlite"), GalleryError);
  assert.throws(() => galleryFilePath("nested/file.jpg"), GalleryError);
  assert.throws(() => galleryFilePath("does-not-exist.jpg"), GalleryError);
});
