import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dbPath } from "./db.js";

export const imagesDir = join(dirname(dbPath), "images");
mkdirSync(imagesDir, { recursive: true });

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif"
]);

const ALLOWED_HOST_HINTS = [
  "colacloud",
  "cloudfront.net",
  "openfoodfacts",
  "openfoodfacts.org",
  "upcitemdb",
  "amazonaws.com",
  "brewfather.app",
  "googleapis.com"
];

function extensionFrom(url: string, contentType?: string | null) {
  const fromType = contentType?.match(/image\/(jpeg|jpg|png|webp|gif|heic|heif)/i)?.[1]?.toLowerCase();
  if (fromType === "jpeg" || fromType === "jpg") return ".jpg";
  if (fromType === "heif") return ".heic";
  if (fromType) return `.${fromType}`;
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"].includes(fromUrl)) {
    if (fromUrl === ".jpeg") return ".jpg";
    if (fromUrl === ".heif") return ".heic";
    return fromUrl;
  }
  return ".jpg";
}

export function sniffImageType(buffer: Buffer): string {
  if (buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase().trim();
    if (["heic", "heix", "heif", "mif1", "msf1", "hevc"].includes(brand)) return "image/heic";
  }
  return "";
}

function extensionForType(contentType: string, originalName?: string) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/heic" || type === "image/heif") return ".heic";
  const fromName = extname(originalName ?? "").toLowerCase();
  if (fromName === ".jpeg") return ".jpg";
  if (fromName === ".heif") return ".heic";
  if ([".jpg", ".png", ".webp", ".gif", ".heic"].includes(fromName)) return fromName;
  return ".jpg";
}

export function saveImageBuffer(buffer: Buffer, contentType?: string | null, originalName?: string) {
  if (!buffer.length) throw new Error("Image required");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is too large (max 10 MB)");
  const sniffed = sniffImageType(buffer);
  const declared = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const type = sniffed || declared;
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error("Use a JPEG, PNG, WebP, GIF, or HEIC photo");
  }
  const normalized = type === "image/jpg" || type === "image/heif" ? (type === "image/jpg" ? "image/jpeg" : "image/heic") : type;
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const ext = extensionForType(normalized, originalName);
  const filename = `${hash}${ext}`;
  const target = join(imagesDir, filename);
  if (!existsSync(target)) writeFileSync(target, buffer);
  return `/api/media/images/${filename}`;
}

export function isLocalImagePath(value?: string | null) {
  return Boolean(value && value.startsWith("/api/media/images/"));
}

export async function localizeImage(remoteUrl?: string | null): Promise<string | null> {
  if (!remoteUrl) return null;
  if (isLocalImagePath(remoteUrl)) return remoteUrl;
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return remoteUrl;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return remoteUrl;

  const hash = createHash("sha256").update(remoteUrl).digest("hex").slice(0, 32);
  const existing = ["jpg", "jpeg", "png", "webp", "gif"]
    .map((ext) => join(imagesDir, `${hash}.${ext}`))
    .find((path) => existsSync(path));
  if (existing) {
    return `/api/media/images/${existing.split(/[/\\]/).pop()}`;
  }

  try {
    const response = await fetch(remoteUrl, {
      headers: { Accept: "image/*,*/*" },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow"
    });
    if (!response.ok || !response.body) return remoteUrl;
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.startsWith("image/") && !ALLOWED_HOST_HINTS.some((hint) => parsed.hostname.includes(hint))) {
      return remoteUrl;
    }
    const ext = extensionFrom(remoteUrl, contentType);
    const filename = `${hash}${ext}`;
    const target = join(imagesDir, filename);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target));
    return `/api/media/images/${filename}`;
  } catch {
    return remoteUrl;
  }
}
