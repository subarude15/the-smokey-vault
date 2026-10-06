import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barcodeFormatName,
  catalogLookupKey,
  normalizeDecodedBarcode
} from "./barcode_normalize.js";

test("UPC-A normalization keeps significant leading zeroes", () => {
  const n = normalizeDecodedBarcode("012345678905", "UPC_A");
  assert.equal(n.cleaned, "012345678905");
  assert.equal(n.canonical, "012345678905");
  assert.equal(n.upcA, "012345678905");
  assert.equal(n.ean13, "0012345678905");
  assert.equal(n.isValidGtin, true);
  assert.equal(n.isLookupKey, true);
});

test("UPC/EAN equivalent forms share one catalog lookup key", () => {
  const upcA = normalizeDecodedBarcode("012345678905", "UPC_A");
  const eanTwin = normalizeDecodedBarcode("0012345678905", "EAN_13");
  assert.equal(upcA.canonical, eanTwin.canonical);
  assert.equal(catalogLookupKey("0012345678905"), catalogLookupKey("012345678905"));
});

test("whitespace and formatting characters are stripped for GTIN codes", () => {
  const n = normalizeDecodedBarcode(" 012-3456 78905 ", "UPC_A");
  assert.equal(n.cleaned, "012345678905");
  assert.equal(n.isLookupKey, true);
});

test("invalid length / malformed values are not lookup keys", () => {
  assert.equal(normalizeDecodedBarcode("12345", "UPC_A").isLookupKey, false);
  assert.equal(normalizeDecodedBarcode("not-a-code", "UPC_A").isLookupKey, false);
  assert.equal(normalizeDecodedBarcode("", "EAN_13").isLookupKey, false);
});

test("EAN-13 non-UPC twin keeps full thirteen digits (no blind zero strip)", () => {
  const n = normalizeDecodedBarcode("5901234123457", "EAN_13");
  assert.equal(n.canonical, "5901234123457");
  assert.equal(n.ean13, "5901234123457");
  assert.equal(n.upcA, "");
  assert.equal(n.isLookupKey, true);
});

test("Code 128 / QR non-digit payloads stay non-lookup keys", () => {
  const code128 = normalizeDecodedBarcode("ABC123", "CODE_128");
  assert.equal(code128.isLookupKey, false);
  assert.equal(code128.cleaned, "ABC123");
  const qr = normalizeDecodedBarcode("https://example.com/x", "QR_CODE");
  assert.equal(qr.isLookupKey, false);
});

test("barcodeFormatName maps ZXing numeric ids", () => {
  assert.equal(barcodeFormatName(14), "UPC_A");
  assert.equal(barcodeFormatName(7), "EAN_13");
  assert.equal(barcodeFormatName(4), "CODE_128");
  assert.equal(barcodeFormatName(99), "UNKNOWN");
});
