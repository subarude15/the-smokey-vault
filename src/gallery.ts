import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { db, dbPath } from "./db.js";
import {
  clipText, MAX_GALLERY_BYTES, MAX_GALLERY_CAPTION, MAX_PATRON_NAME,
  type GalleryMedia, type GalleryMediaType
} from "./speakeasy-shared.js";

export const galleryDir = join(dirname(dbPath), "gallery");
mkdirSync(galleryDir, { recursive: true });

export class GalleryError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov"
};

export const GALLERY_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime"
};

/**
 * Trusts the file's own magic bytes over the declared MIME type, because iOS Safari
 * sends `application/octet-stream` for camera captures often enough to matter.
 */
export function sniffGalleryType(buffer: Buffer): string {
  if (buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12).toLowerCase();
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  return "";
}

function resolveType(buffer: Buffer, declared?: string | null, originalName?: string) {
  const sniffed = sniffGalleryType(buffer);
  if (sniffed) return sniffed;
  const stated = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (IMAGE_EXTENSIONS[stated] || VIDEO_EXTENSIONS[stated]) return stated;
  const ext = extname(originalName ?? "").toLowerCase();
  const byExtension = Object.entries(GALLERY_CONTENT_TYPES).find(([known]) => known === (ext === ".jpeg" ? ".jpg" : ext));
  return byExtension?.[1] ?? "";
}

export function mediaRowToJson(row: {
  id: number; filename: string; media_type: string; caption: string; uploaded_by: string; created_at: string;
}): GalleryMedia {
  return {
    id: row.id,
    filename: row.filename,
    media_type: row.media_type as GalleryMediaType,
    caption: row.caption,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    url: `/api/media/gallery/${row.filename}`,
    download_url: `/api/media/gallery/${row.filename}/download`
  };
}

export function listGallery(): GalleryMedia[] {
  const rows = db.prepare(`SELECT id, filename, media_type, caption, uploaded_by, created_at
    FROM gallery_media ORDER BY created_at DESC, id DESC`).all() as Parameters<typeof mediaRowToJson>[0][];
  return rows.map(mediaRowToJson);
}

export function saveGalleryUpload(input: {
  buffer: Buffer;
  contentType?: string | null;
  originalName?: string;
  caption?: string;
  uploadedBy?: string;
}): GalleryMedia {
  if (!input.buffer.length) throw new GalleryError("Pick a photo or video first");
  if (input.buffer.length > MAX_GALLERY_BYTES) {
    throw new GalleryError("That clip is over 150 MB. Trim it down and try again.", 413);
  }

  const type = resolveType(input.buffer, input.contentType, input.originalName);
  const extension = IMAGE_EXTENSIONS[type] ?? VIDEO_EXTENSIONS[type];
  if (!extension) {
    throw new GalleryError("Use a JPEG, PNG, or WebP photo, or an MP4, WebM, or MOV video");
  }
  const mediaType: GalleryMediaType = IMAGE_EXTENSIONS[type] ? "image" : "video";

  const hash = createHash("sha256").update(input.buffer).digest("hex").slice(0, 32);
  const filename = `${hash}${extension}`;
  const target = join(galleryDir, filename);
  if (!existsSync(target)) writeFileSync(target, input.buffer);

  const caption = clipText(input.caption ?? "", MAX_GALLERY_CAPTION);
  const uploadedBy = clipText(input.uploadedBy ?? "", MAX_PATRON_NAME) || "Patron";
  const result = db.prepare(`INSERT INTO gallery_media(filename, media_type, caption, uploaded_by)
    VALUES(?,?,?,?)`).run(filename, mediaType, caption, uploadedBy);

  const row = db.prepare(`SELECT id, filename, media_type, caption, uploaded_by, created_at
    FROM gallery_media WHERE id=?`).get(result.lastInsertRowid) as Parameters<typeof mediaRowToJson>[0];
  return mediaRowToJson(row);
}

export function deleteGalleryMedia(id: number) {
  const row = db.prepare("SELECT filename FROM gallery_media WHERE id=?").get(id) as { filename: string } | undefined;
  if (!row) throw new GalleryError("That item is already gone", 404);
  db.prepare("DELETE FROM gallery_media WHERE id=?").run(id);

  const stillUsed = db.prepare("SELECT COUNT(*) AS c FROM gallery_media WHERE filename=?").get(row.filename) as { c: number };
  if (stillUsed.c === 0) {
    const target = join(galleryDir, row.filename);
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // The row is gone either way; a leftover file is not worth failing the request.
    }
  }
  return { ok: true };
}

export function galleryFilePath(file: string) {
  if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    throw new GalleryError("Invalid media path");
  }
  const path = join(galleryDir, file);
  if (!existsSync(path)) throw new GalleryError("Media not found", 404);
  return path;
}
