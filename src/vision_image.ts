import { sniffImageType } from "./images.js";

export const VISION_MAX_EDGE = 1024;
export const VISION_JPEG_QUALITY = 72;

/**
 * Shrinks a label photo before it leaves the NAS for Gemini / failover.
 * Sharp is optional at runtime so unit tests can still parse labels without it.
 */
export async function downscaleVisionImage(buffer: Buffer): Promise<{ base64: string; mime: "image/jpeg" }> {
  try {
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default;
    const out = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: VISION_MAX_EDGE,
        height: VISION_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: VISION_JPEG_QUALITY })
      .toBuffer();
    return { base64: out.toString("base64"), mime: "image/jpeg" };
  } catch {
    const type = sniffImageType(buffer);
    if (type && type !== "image/jpeg" && type !== "image/jpg") {
      // Still send the original bytes if we cannot transcode; the provider may accept PNG/WebP.
      return { base64: buffer.toString("base64"), mime: "image/jpeg" };
    }
    return { base64: buffer.toString("base64"), mime: "image/jpeg" };
  }
}
