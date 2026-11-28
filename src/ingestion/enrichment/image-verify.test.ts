import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  prepareImageForVision,
  VISION_VERIFY_MAX_EDGE_PX
} from "./image-verify.js";

test("prepareImageForVision downscales high-resolution product images to fit within VISION_VERIFY_MAX_EDGE_PX", async () => {
  const largePng = await sharp({
    create: {
      width: 1600,
      height: 2400,
      channels: 3,
      background: { r: 120, g: 70, b: 30 }
    }
  })
    .png()
    .toBuffer();

  const encoded = await prepareImageForVision(largePng);
  const outBuf = Buffer.from(encoded, "base64");
  const meta = await sharp(outBuf).metadata();

  assert.equal(meta.format, "jpeg");
  assert.ok((meta.width ?? 0) <= VISION_VERIFY_MAX_EDGE_PX);
  assert.ok((meta.height ?? 0) <= VISION_VERIFY_MAX_EDGE_PX);
  assert.equal(meta.height, VISION_VERIFY_MAX_EDGE_PX);
  assert.equal(meta.width, 512);
});

test("prepareImageForVision also downscales oversized base64 payloads passed directly", async () => {
  const largePng = await sharp({
    create: {
      width: 2000,
      height: 1500,
      channels: 3,
      background: { r: 40, g: 40, b: 40 }
    }
  })
    .png()
    .toBuffer();

  const encoded = await prepareImageForVision(largePng.toString("base64"));
  const meta = await sharp(Buffer.from(encoded, "base64")).metadata();

  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, VISION_VERIFY_MAX_EDGE_PX);
  assert.equal(meta.height, 576);
});

test("prepareImageForVision passes small images through unchanged", async () => {
  const smallJpeg = await sharp({
    create: {
      width: 320,
      height: 480,
      channels: 3,
      background: { r: 200, g: 180, b: 140 }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  const inputBase64 = smallJpeg.toString("base64");
  const outputBase64 = await prepareImageForVision(inputBase64);
  assert.equal(outputBase64, inputBase64);
});

test("prepareImageForVision falls back to original base64 when bytes are not a decodable image", async () => {
  const synthetic = Buffer.from("synthetic-vision-test-payload-not-an-image-0123456789").toString("base64");
  const output = await prepareImageForVision(synthetic);
  assert.equal(output, synthetic);
});
