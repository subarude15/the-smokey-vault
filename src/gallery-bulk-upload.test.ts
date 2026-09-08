/**
 * PR128 — Gallery bulk selection / batch-status helpers.
 * Server still uses the existing single-file POST /api/gallery/upload path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  canRemoveGalleryUpload,
  fileIdentity,
  formatGalleryBatchPartialMessage,
  formatGalleryBatchSuccessMessage,
  formatGalleryUploadProgress,
  formatGalleryUploadSummary,
  galleryUploadsReadyToSend,
  mergeGallerySelections,
  prepareGalleryUploadRetry,
  removeGalleryUpload,
  setGalleryUploadStatus,
  summarizeGalleryUploads,
  type PendingGalleryUpload,
  validateGalleryFileSize
} from "../client/src/gallery-upload.ts";

const root = process.cwd();
const MAX = 150 * 1024 * 1024;

function fakeFile(name: string, size: number, lastModified = 1, type = "image/jpeg"): File {
  const buffer = Buffer.alloc(Math.min(size, 16));
  const file = new File([buffer], name, { type, lastModified });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function pending(file: File, id = file.name): PendingGalleryUpload {
  return { id, file, status: "pending" };
}

test("multiple selected files can be represented in one batch", () => {
  const batch = mergeGallerySelections([], [
    fakeFile("a.jpg", 1024),
    fakeFile("b.jpg", 2048),
    fakeFile("clip.mov", 4096, 2, "video/quicktime")
  ], MAX, () => `id-${Math.random()}`);

  assert.equal(batch.length, 3);
  assert.equal(batch[0].status, "pending");
  assert.equal(batch[1].status, "pending");
  assert.equal(batch[2].status, "pending");
  assert.equal(summarizeGalleryUploads(batch).uploadable, 3);
});

test("oversized files are rejected independently without discarding valid picks", () => {
  const ok = fakeFile("ok.jpg", 1024);
  const huge = fakeFile("huge.mov", MAX + 1, 2, "video/mp4");
  const alsoOk = fakeFile("also.jpg", 2048, 3);

  const batch = mergeGallerySelections([], [ok, huge, alsoOk], MAX, (() => {
    let n = 0;
    return () => `id-${++n}`;
  })());

  assert.equal(batch.length, 3);
  assert.equal(batch[0].status, "pending");
  assert.equal(batch[1].status, "rejected");
  assert.match(batch[1].error ?? "", /limit/i);
  assert.equal(batch[2].status, "pending");

  const counts = summarizeGalleryUploads(batch);
  assert.equal(counts.pending, 2);
  assert.equal(counts.rejected, 1);
  assert.equal(counts.uploadable, 2);
  assert.deepEqual(galleryUploadsReadyToSend(batch).map((item) => item.file.name), ["ok.jpg", "also.jpg"]);
});

test("validateGalleryFileSize reports oversize clearly", () => {
  assert.equal(validateGalleryFileSize(fakeFile("x.jpg", MAX), MAX), undefined);
  assert.match(validateGalleryFileSize(fakeFile("x.jpg", MAX + 1), MAX) ?? "", /limit/i);
});

test("duplicate selections are not added twice in the same modal session", () => {
  const first = fakeFile("dup.jpg", 5000, 42);
  const again = fakeFile("dup.jpg", 5000, 42);
  const different = fakeFile("dup.jpg", 5000, 43);

  let batch = mergeGallerySelections([], [first], MAX, () => "a");
  batch = mergeGallerySelections(batch, [again, different], MAX, (() => {
    let n = 0;
    return () => `b-${++n}`;
  })());

  assert.equal(batch.length, 2);
  assert.equal(fileIdentity(first), fileIdentity(again));
  assert.notEqual(fileIdentity(first), fileIdentity(different));
});

test("success and failure counters summarize correctly", () => {
  const items: PendingGalleryUpload[] = [
    { ...pending(fakeFile("1.jpg", 1), "1"), status: "success" },
    { ...pending(fakeFile("2.jpg", 1), "2"), status: "failed", error: "nope" },
    { ...pending(fakeFile("3.jpg", 1), "3"), status: "pending" },
    { ...pending(fakeFile("4.jpg", 1), "4"), status: "uploading" },
    { ...pending(fakeFile("5.jpg", 1), "5"), status: "rejected", error: "too big" }
  ];

  const counts = summarizeGalleryUploads(items);
  assert.equal(counts.success, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.pending, 1);
  assert.equal(counts.uploading, 1);
  assert.equal(counts.rejected, 1);
  assert.equal(counts.remaining, 2);
  assert.equal(formatGalleryUploadSummary(counts), "1 uploaded · 1 failed · 2 remaining · 1 skipped");
  assert.equal(formatGalleryBatchPartialMessage(7, 1), "7 added · 1 failed");
  assert.equal(formatGalleryBatchSuccessMessage(1), "Added 1 memory to the gallery");
  assert.equal(formatGalleryBatchSuccessMessage(8), "Added 8 memories to the gallery");
  assert.equal(formatGalleryUploadProgress(3, 8), "Uploading 3 of 8");
});

test("retry prepares failed items only and leaves successes alone", () => {
  const items: PendingGalleryUpload[] = [
    { ...pending(fakeFile("ok.jpg", 1), "ok"), status: "success" },
    { ...pending(fakeFile("bad.jpg", 1), "bad"), status: "failed", error: "server" },
    { ...pending(fakeFile("wait.jpg", 1), "wait"), status: "pending" }
  ];

  const retried = prepareGalleryUploadRetry(items);
  assert.equal(retried.find((item) => item.id === "ok")?.status, "success");
  assert.equal(retried.find((item) => item.id === "bad")?.status, "pending");
  assert.equal(retried.find((item) => item.id === "bad")?.error, undefined);
  assert.equal(retried.find((item) => item.id === "wait")?.status, "pending");
  assert.deepEqual(galleryUploadsReadyToSend(retried).map((item) => item.id), ["bad", "wait"]);
});

test("status updates and removable rows behave as expected", () => {
  let items = mergeGallerySelections([], [fakeFile("a.jpg", 10), fakeFile("b.jpg", 20, 2)], MAX, (() => {
    let n = 0;
    return () => `id-${++n}`;
  })());

  items = setGalleryUploadStatus(items, "id-1", "uploading");
  assert.equal(items[0].status, "uploading");
  assert.equal(canRemoveGalleryUpload(items[0]), false);

  items = setGalleryUploadStatus(items, "id-1", "failed", "boom");
  assert.equal(items[0].error, "boom");
  assert.equal(canRemoveGalleryUpload(items[0]), true);

  items = removeGalleryUpload(items, "id-1");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "id-2");

  items = setGalleryUploadStatus(items, "id-2", "success");
  const blocked = removeGalleryUpload(items, "id-2");
  assert.equal(blocked.length, 1);
});

test("GalleryPage wires multi-select and batch upload UX", () => {
  const page = readFileSync(join(root, "client/src/GalleryPage.tsx"), "utf8");
  assert.match(page, /multiple/);
  assert.match(page, /mergeGallerySelections/);
  assert.match(page, /gallery\/upload/);
  assert.match(page, /Retry failed/);
  assert.doesNotMatch(page, /capture="environment"[^>]*multiple/);
  // Camera input must not gain multiple; device picker must.
  assert.match(page, /ref=\{pickerRef\}[^>]*multiple|multiple[^>]*ref=\{pickerRef\}/);
  // FileList must be snapshotted before the input is cleared.
  assert.match(page, /const picked = Array\.from\(list\)/);
  assert.match(page, /mergeGallerySelections\(prev, picked/);
});
