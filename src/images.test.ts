import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { imagesDir, saveImageBuffer, sniffImageType } from "./images.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

test("sniffImageType recognizes PNG magic bytes", () => {
  assert.equal(sniffImageType(png), "image/png");
  assert.equal(sniffImageType(Buffer.from("not-an-image")), "");
});

test("saveImageBuffer stores a PNG and returns a local media URL", () => {
  const url = saveImageBuffer(png, "image/png", "label.png");
  assert.match(url, /^\/api\/media\/images\/[a-f0-9]{32}\.png$/);
  const filename = url.split("/").pop()!;
  const path = join(imagesDir, filename);
  assert.equal(existsSync(path), true);
  const again = saveImageBuffer(png, "image/png", "label.png");
  assert.equal(again, url);
  unlinkSync(path);
});

test("saveImageBuffer rejects non-images", () => {
  assert.throws(() => saveImageBuffer(Buffer.from("hello"), "text/plain", "notes.txt"), /JPEG, PNG/);
});
