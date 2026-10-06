import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import sharp from "sharp";
import { decodeBarcodeFromImageBuffer } from "./barcode_decode.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "barcodes");
const decodeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "barcode_decode.ts"), "utf8");

test("UPC-A decodes successfully from fixture", async () => {
  const buffer = readFileSync(join(fixtures, "upc-a-012345678905.png"));
  const decoded = await decodeBarcodeFromImageBuffer(buffer);
  assert.ok(decoded);
  assert.equal(decoded!.formatName, "UPC_A");
  assert.equal(decoded!.rawValue, "012345678905");
  assert.equal(decoded!.normalized.canonical, "012345678905");
  assert.equal(decoded!.normalized.isLookupKey, true);
});

test("EAN-13 decodes successfully from fixture", async () => {
  const buffer = readFileSync(join(fixtures, "ean13-5901234123457.png"));
  const decoded = await decodeBarcodeFromImageBuffer(buffer);
  assert.ok(decoded);
  assert.equal(decoded!.formatName, "EAN_13");
  assert.equal(decoded!.rawValue, "5901234123457");
  assert.equal(decoded!.normalized.isLookupKey, true);
});

test("invalid / empty barcode image is ignored (null)", async () => {
  const blank = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).png().toBuffer();
  assert.equal(await decodeBarcodeFromImageBuffer(blank), null);
  assert.equal(await decodeBarcodeFromImageBuffer(Buffer.alloc(0)), null);
});

test("decoder failure on corrupt bytes returns null instead of throwing", async () => {
  const result = await decodeBarcodeFromImageBuffer(Buffer.from("not-an-image"));
  assert.equal(result, null);
});

test("decode path auto-orients via sharp.rotate() before greyscale/raw", () => {
  // Phone JPEGs often store rotated pixels + EXIF Orientation; sharp().rotate() applies that.
  assert.match(decodeSource, /\.rotate\(\)/);
  assert.match(decodeSource, /\.greyscale\(\)/);
  assert.match(decodeSource, /\.raw\(\)/);
  const rotateAt = decodeSource.indexOf(".rotate()");
  const greyAt = decodeSource.indexOf(".greyscale()");
  const rawAt = decodeSource.indexOf(".raw()");
  assert.ok(rotateAt > 0 && rotateAt < greyAt && greyAt < rawAt);
});

test("UPC-A still decodes when JPEG carries EXIF orientation metadata", async () => {
  const png = readFileSync(join(fixtures, "upc-a-012345678905.png"));
  // Orientation 1 is upright; presence of EXIF must not break the sharp.rotate() → ZXing path.
  const jpeg = await sharp(png).jpeg().withMetadata({ orientation: 1 }).toBuffer();
  const decoded = await decodeBarcodeFromImageBuffer(jpeg);
  assert.ok(decoded);
  assert.equal(decoded!.rawValue, "012345678905");
});
