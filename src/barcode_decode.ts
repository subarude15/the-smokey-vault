/**
 * Server-side deterministic barcode decoding from uploaded image buffers.
 * Uses the already-installed @zxing/library (pure JS) + sharp for greyscale pixels.
 * Never uses an LLM/OCR for stripe decoding.
 */
import ZXing from "@zxing/library";
import sharp from "sharp";
import {
  barcodeFormatName,
  normalizeDecodedBarcode,
  type NormalizedBarcode
} from "./barcode_normalize.js";

const {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer
} = ZXing;

export type DecodedBarcode = {
  /** Raw text from the decoder (before GTIN normalization). */
  rawValue: string;
  /** ZXing format enum numeric id. */
  format: number;
  /** Stable string name such as UPC_A / EAN_13. */
  formatName: string;
  normalized: NormalizedBarcode;
};

const POSSIBLE_FORMATS = [
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.EAN_8,
  BarcodeFormat.EAN_13,
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE
];

function buildReader() {
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, POSSIBLE_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  return reader;
}

/**
 * Decode the first barcode found in an image buffer.
 * Returns null when none is found or decoding throws — callers continue to vision.
 */
export async function decodeBarcodeFromImageBuffer(buffer: Buffer): Promise<DecodedBarcode | null> {
  if (!buffer?.length) return null;
  try {
    const { data, info } = await sharp(buffer, { failOn: "none" })
      .rotate()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || data.length < info.width * info.height) return null;

    const luminances = Uint8ClampedArray.from(data.subarray(0, info.width * info.height));
    const source = new RGBLuminanceSource(luminances, info.width, info.height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const reader = buildReader();
    // @zxing/library console.warns NotFoundException from some readers; mute for the decode call only.
    const prevWarn = console.warn;
    console.warn = () => undefined;
    let result: ReturnType<typeof reader.decode>;
    try {
      result = reader.decode(bitmap);
    } finally {
      console.warn = prevWarn;
    }
    const rawValue = String(result.getText() ?? "").trim();
    if (!rawValue) return null;
    const format = Number(result.getBarcodeFormat());
    const formatName = barcodeFormatName(format);
    return {
      rawValue,
      format,
      formatName,
      normalized: normalizeDecodedBarcode(rawValue, formatName)
    };
  } catch {
    // NotFound / checksum / sharp failures must not fail the scan.
    return null;
  }
}

export { POSSIBLE_FORMATS as ZXING_SCAN_FORMATS };
