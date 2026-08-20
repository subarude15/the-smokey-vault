import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dbPath } from "./db.js";

export const imagesDir = join(dirname(dbPath), "images");
mkdirSync(imagesDir, { recursive: true });

const ALLOWED_HOST_HINTS = [
  "colacloud",
  "cloudfront.net",
  "openfoodfacts",
  "openfoodfacts.org",
  "upcitemdb",
  "amazonaws.com"
];

function extensionFrom(url: string, contentType?: string | null) {
  const fromType = contentType?.match(/image\/(jpeg|jpg|png|webp|gif)/i)?.[1]?.toLowerCase();
  if (fromType === "jpeg") return ".jpg";
  if (fromType) return `.${fromType}`;
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(fromUrl)) return fromUrl === ".jpeg" ? ".jpg" : fromUrl;
  return ".jpg";
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
