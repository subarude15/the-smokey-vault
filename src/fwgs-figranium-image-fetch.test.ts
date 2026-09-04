/**
 * FWGS Figranium browser image-fetch fallback unit tests.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { deflateSync } from "node:zlib";
import {
  fetchFwgsImageViaFigranium,
  isFwgsFigraniumImageFetchConfigured
} from "./fwgs-figranium.js";
import { IMAGE_DOWNLOAD_MAX_BYTES } from "./images.js";

const originalFetch = globalThis.fetch;
const envKeys = [
  "FIGRANIUM_API_KEY",
  "FIGRANIUM_BASE_URL",
  "FIGRANIUM_FWGS_IMAGE_TASK_ID",
  "FIGRANIUM_FWGS_IMAGE_FETCH_TASK_ID"
] as const;
const savedEnv = new Map<string, string | undefined>();

const VALID_IMAGE =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000004766_F1.jpg&height=475&width=475";
const WRONG_HOST =
  "https://cdn.example.com/products/000004766_F1.jpg";
const WRONG_PLCB =
  "https://www.finewineandgoodspirits.com/ccstore/v1/images/?source=/file/v1/products/000008865_F1.jpg&height=475&width=475";

function stashEnv() {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
}

function restoreEnv() {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
}

function configureFetchEnv() {
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID = "task_images";
  process.env.FIGRANIUM_FWGS_IMAGE_FETCH_TASK_ID = "task_image_fetch";
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function mockFigraniumSuccess(data: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ outcome: "success", data }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
}

afterEach(() => {
  restoreEnv();
});

test("isFwgsFigraniumImageFetchConfigured requires fetch task id", () => {
  stashEnv();
  configureFetchEnv();
  assert.equal(isFwgsFigraniumImageFetchConfigured(), true);
  delete process.env.FIGRANIUM_FWGS_IMAGE_FETCH_TASK_ID;
  assert.equal(isFwgsFigraniumImageFetchConfigured(), false);
});

test("fetchFwgsImageViaFigranium rejects wrong host before contacting Figranium", async () => {
  stashEnv();
  configureFetchEnv();
  let contacted = false;
  globalThis.fetch = (async () => {
    contacted = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const result = await fetchFwgsImageViaFigranium(WRONG_HOST, "000004766");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_url");
  assert.equal(contacted, false);
});

test("fetchFwgsImageViaFigranium rejects mismatched PLCB image URL before contact", async () => {
  stashEnv();
  configureFetchEnv();
  let contacted = false;
  globalThis.fetch = (async () => {
    contacted = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const result = await fetchFwgsImageViaFigranium(WRONG_PLCB, "000004766");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_url");
  assert.equal(contacted, false);
});

test("fetchFwgsImageViaFigranium accepts valid JPEG/PNG payload", async () => {
  stashEnv();
  configureFetchEnv();
  const png = makePng(800, 800);
  mockFigraniumSuccess({
    matched: true,
    plcbItem: "000004766",
    sourceUrl: VALID_IMAGE,
    contentType: "image/png",
    byteLength: png.length,
    base64: png.toString("base64")
  });
  const result = await fetchFwgsImageViaFigranium(VALID_IMAGE, "4766");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.contentType, "image/png");
    assert.equal(result.image.width, 800);
    assert.equal(result.image.height, 800);
    assert.equal(result.image.plcbItem, "000004766");
  }
});

test("fetchFwgsImageViaFigranium rejects returned PLCB mismatch", async () => {
  stashEnv();
  configureFetchEnv();
  const png = makePng(64, 64);
  mockFigraniumSuccess({
    matched: true,
    plcbItem: "000008865",
    sourceUrl: VALID_IMAGE,
    contentType: "image/png",
    byteLength: png.length,
    base64: png.toString("base64")
  });
  const result = await fetchFwgsImageViaFigranium(VALID_IMAGE, "000004766");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "plcb_mismatch");
});

test("fetchFwgsImageViaFigranium rejects malformed base64", async () => {
  stashEnv();
  configureFetchEnv();
  mockFigraniumSuccess({
    matched: true,
    plcbItem: "000004766",
    sourceUrl: VALID_IMAGE,
    contentType: "image/jpeg",
    byteLength: 12,
    base64: "!!!not-base64!!!"
  });
  const result = await fetchFwgsImageViaFigranium(VALID_IMAGE, "000004766");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_base64");
});

test("fetchFwgsImageViaFigranium rejects non-image payload", async () => {
  stashEnv();
  configureFetchEnv();
  const bytes = Buffer.from("not an image payload at all!!");
  mockFigraniumSuccess({
    matched: true,
    plcbItem: "000004766",
    sourceUrl: VALID_IMAGE,
    contentType: "text/plain",
    byteLength: bytes.length,
    base64: bytes.toString("base64")
  });
  const result = await fetchFwgsImageViaFigranium(VALID_IMAGE, "000004766");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "non_image");
});

test("fetchFwgsImageViaFigranium rejects oversized payloads", async () => {
  stashEnv();
  configureFetchEnv();
  const over = IMAGE_DOWNLOAD_MAX_BYTES + 1;
  mockFigraniumSuccess({
    matched: true,
    plcbItem: "000004766",
    sourceUrl: VALID_IMAGE,
    contentType: "image/jpeg",
    byteLength: over,
    base64: Buffer.alloc(16, 1).toString("base64")
  });
  const result = await fetchFwgsImageViaFigranium(VALID_IMAGE, "000004766");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "oversized");
});

test("fetchFwgsImageViaFigranium throws typed provider error on Figranium 502/503", async () => {
  stashEnv();
  configureFetchEnv();
  const { FwgsFigraniumProviderError, isFwgsFigraniumProviderError } = await import(
    "./fwgs-figranium.js"
  );
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ outcome: "error", error: "boom" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
  await assert.rejects(
    () => fetchFwgsImageViaFigranium(VALID_IMAGE, "000004766"),
    (error: unknown) => {
      assert.equal(isFwgsFigraniumProviderError(error), true);
      assert.ok(error instanceof FwgsFigraniumProviderError);
      assert.equal(error.kind, "retryable_error");
      return true;
    }
  );
});

