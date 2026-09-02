import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { dbPath } from "./db.js";
import {
  MAX_SAFE_REDIRECTS,
  NetworkSafetyError,
  fetchSafeHttp,
  headerValue,
  parseSafeHttpUrl,
  sanitizeUrlForLog,
  type FetchSafeOptions,
  type LookupFn,
  type PinnedRequestFn
} from "./network_safety.js";

export const imagesDir = join(dirname(dbPath), "images");
mkdirSync(imagesDir, { recursive: true });

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

function positiveInt(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Hard cap for remote image downloads. Env override: IMAGE_DOWNLOAD_MAX_BYTES. */
export const IMAGE_DOWNLOAD_MAX_BYTES = positiveInt(process.env.IMAGE_DOWNLOAD_MAX_BYTES, MAX_IMAGE_BYTES);

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif"
]);

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

export function isAllowedImageContentType(contentType?: string | null) {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return ALLOWED_TYPES.has(type);
}

export type LocalizeImageLog = {
  hostname: string;
  url: string;
  outcome: "ok" | "skip" | "reject";
  reason?: string;
  status?: number;
  bytes?: number;
  contentType?: string;
};

export type LocalizeImageDeps = {
  lookup?: LookupFn;
  request?: PinnedRequestFn;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  log?: (entry: LocalizeImageLog) => void;
};

function removeTemp(path: string) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // A leftover part file is cleaned on the next failure; do not throw from cleanup.
  }
}

async function writeLimitedStream(source: Readable, destPath: string, maxBytes: number): Promise<number> {
  let bytes = 0;
  const out = createWriteStream(destPath);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        source.destroy();
        out.destroy();
        reject(error);
      };
      source.on("error", fail);
      out.on("error", fail);
      source.on("data", (chunk: Buffer | string) => {
        const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        bytes += size;
        if (bytes > maxBytes) {
          fail(new NetworkSafetyError("Image is too large (max 10 MB)", "too_large"));
        }
      });
      out.on("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      source.pipe(out);
    });
    return bytes;
  } catch (error) {
    removeTemp(destPath);
    throw error;
  }
}

export async function localizeImage(remoteUrl?: string | null, deps: LocalizeImageDeps = {}): Promise<string | null> {
  if (!remoteUrl) return null;
  if (isLocalImagePath(remoteUrl)) return remoteUrl;

  const log = (entry: Omit<LocalizeImageLog, "url" | "hostname"> & { url?: string; hostname?: string }) => {
    if (!deps.log) return;
    let hostname = entry.hostname ?? "";
    let url = entry.url ?? "";
    try {
      const parsed = new URL(remoteUrl);
      hostname ||= parsed.hostname;
      url ||= sanitizeUrlForLog(parsed);
    } catch {
      url ||= "invalid url";
    }
    deps.log({ ...entry, hostname, url });
  };

  let parsed: URL;
  try {
    parsed = parseSafeHttpUrl(remoteUrl);
  } catch {
    return remoteUrl;
  }

  const hash = createHash("sha256").update(remoteUrl).digest("hex").slice(0, 32);
  const existing = ["jpg", "jpeg", "png", "webp", "gif"]
    .map((ext) => join(imagesDir, `${hash}.${ext}`))
    .find((path) => existsSync(path));
  if (existing) {
    return `/api/media/images/${existing.split(/[/\\]/).pop()}`;
  }

  const timeoutMs = deps.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? IMAGE_DOWNLOAD_MAX_BYTES;
  const fetchOptions: FetchSafeOptions = {
    timeoutMs,
    maxRedirects: deps.maxRedirects ?? MAX_SAFE_REDIRECTS,
    lookup: deps.lookup,
    request: deps.request,
    headers: { Accept: "image/*" }
  };

  const tempPath = join(imagesDir, `.tmp-${hash}-${randomBytes(8).toString("hex")}`);
  try {
    const response = await fetchSafeHttp(parsed, fetchOptions);
    if (response.status < 200 || response.status >= 300 || !response.body) {
      response.body?.destroy();
      log({ outcome: "reject", reason: "http_status", status: response.status });
      return remoteUrl;
    }

    const contentType = headerValue(response.headers, "content-type");
    if (contentType && !isAllowedImageContentType(contentType)) {
      response.body.destroy();
      log({ outcome: "reject", reason: "content_type", status: response.status, contentType: contentType.split(";")[0] });
      return remoteUrl;
    }

    const declaredLength = Number(headerValue(response.headers, "content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.body.destroy();
      log({ outcome: "reject", reason: "content_length", status: response.status, bytes: declaredLength, contentType: contentType.split(";")[0] });
      return remoteUrl;
    }

    const bytes = await writeLimitedStream(response.body, tempPath, maxBytes);
    const sniffed = existsSync(tempPath) ? sniffImageType(readFileSync(tempPath).subarray(0, 16)) : "";
    if (!isAllowedImageContentType(contentType) && !isAllowedImageContentType(sniffed)) {
      removeTemp(tempPath);
      log({ outcome: "reject", reason: "not_image", status: response.status, bytes, contentType: contentType.split(";")[0] });
      return remoteUrl;
    }

    const ext = extensionFrom(remoteUrl, sniffed || contentType);
    const filename = `${hash}${ext}`;
    const target = join(imagesDir, filename);
    if (existsSync(target)) {
      removeTemp(tempPath);
      return `/api/media/images/${filename}`;
    }
    renameSync(tempPath, target);
    log({ outcome: "ok", status: response.status, bytes, contentType: (sniffed || contentType).split(";")[0] });
    return `/api/media/images/${filename}`;
  } catch (error) {
    removeTemp(tempPath);
    const reason = error instanceof NetworkSafetyError ? error.reason : "fetch_error";
    log({ outcome: "reject", reason });
    return remoteUrl;
  }
}
