/**
 * Minimal image dimension readers from file headers (JPEG / PNG / GIF / WebP).
 * Used by the image probe — no full decode, no external deps.
 */
export type ImageHeaderDimensions = { width: number; height: number };

function u16be(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset);
}

function u32be(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function u16le(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function u32le(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readPng(buf: Buffer): ImageHeaderDimensions | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  // IHDR starts at byte 16 after 8-byte signature + 8-byte chunk header
  const width = u32be(buf, 16);
  const height = u32be(buf, 20);
  if (width > 0 && height > 0 && width < 100_000 && height < 100_000) {
    return { width, height };
  }
  return null;
}

function readGif(buf: Buffer): ImageHeaderDimensions | null {
  if (buf.length < 10) return null;
  const sig = buf.subarray(0, 6).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const width = u16le(buf, 6);
  const height = u16le(buf, 8);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function readJpeg(buf: Buffer): ImageHeaderDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const size = u16be(buf, offset + 2);
    if (size < 2) return null;
    // SOF0–SOF3 / SOF5–SOF7 / SOF9–SOF11 / SOF13–SOF15
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && offset + 9 < buf.length) {
      const height = u16be(buf, offset + 5);
      const width = u16be(buf, offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    offset += 2 + size;
  }
  return null;
}

function readWebp(buf: Buffer): ImageHeaderDimensions | null {
  if (buf.length < 30) return null;
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const chunk = buf.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buf.length >= 30) {
    const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
    if (width > 0 && height > 0) return { width, height };
  }
  if (chunk === "VP8 " && buf.length >= 30) {
    // Lossy bitstream: frame tag then 3-byte start code 0x9d 0x01 0x2a then width/height
    const start = 20;
    if (buf[start] === 0x9d && buf[start + 1] === 0x01 && buf[start + 2] === 0x2a) {
      const width = u16le(buf, start + 3) & 0x3fff;
      const height = u16le(buf, start + 5) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    // Signature 0x2f then 14-bit width-1 / height-1
    if (buf[20] !== 0x2f) return null;
    const bits = u32le(buf, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

/** Parse width/height from the leading bytes of an image payload. */
export function readImageDimensionsFromHeader(buf: Buffer): ImageHeaderDimensions | null {
  if (!buf?.length) return null;
  return readPng(buf) || readGif(buf) || readJpeg(buf) || readWebp(buf);
}
