import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, dbPath } from "./db.js";
import {
  ensureGalleryVideoPoster,
  galleryPosterFilename,
  generateGalleryVideoPoster,
} from "./gallery-poster.js";
import {
  clipText,
  galleryOversizeMessage,
  GENERAL_GALLERY_ALBUM_NAME,
  MAX_GALLERY_ALBUM_NAME,
  MAX_GALLERY_BYTES,
  MAX_GALLERY_CAPTION,
  MAX_PATRON_NAME,
  type GalleryAlbum,
  type GalleryMedia,
  type GalleryMediaType
} from "./speakeasy-shared.js";

export { galleryPosterFilename };

export const galleryDir = join(dirname(dbPath), "gallery");
mkdirSync(galleryDir, { recursive: true });

/**
 * Temp uploads live on the SAME filesystem as galleryDir so finalization is an
 * atomic rename (no cross-device EXDEV copy) and a crash never leaves a durable
 * file half-written. Partial temp files are always cleaned up on failure.
 */
export const galleryTmpDir = join(galleryDir, "tmp");
mkdirSync(galleryTmpDir, { recursive: true });

/** Bytes sniffed from the front of an upload to validate media type without buffering the whole file. */
const GALLERY_SNIFF_BYTES = 4096;

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

const MEDIA_COLUMNS = "id, filename, media_type, caption, uploaded_by, album_id, created_at";
const ALBUM_COLUMNS = "id, name, event_id, is_default, created_at, updated_at";

type MediaRow = {
  id: number;
  filename: string;
  media_type: string;
  caption: string;
  uploaded_by: string;
  album_id: number | null;
  created_at: string;
};

type AlbumRow = {
  id: number;
  name: string;
  event_id: number | null;
  is_default: 0 | 1;
  created_at: string;
  updated_at: string;
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

function normalizeAlbumName(raw: unknown): string {
  const name = clipText(raw, MAX_GALLERY_ALBUM_NAME);
  if (!name) throw new GalleryError("Give the album a name");
  return name;
}

function albumExistsCaseInsensitive(name: string, exceptId?: number): boolean {
  const row = exceptId == null
    ? db.prepare("SELECT id FROM gallery_albums WHERE name = ? COLLATE NOCASE").get(name)
    : db.prepare("SELECT id FROM gallery_albums WHERE name = ? COLLATE NOCASE AND id != ?").get(name, exceptId);
  return Boolean(row);
}

function getAlbumRow(id: number): AlbumRow {
  const row = db.prepare(`SELECT ${ALBUM_COLUMNS} FROM gallery_albums WHERE id=?`).get(id) as AlbumRow | undefined;
  if (!row) throw new GalleryError("Album not found", 404);
  return row;
}

/** Ensure exactly one General/default album and attach orphaned media to it. Idempotent. */
export function ensureDefaultGalleryAlbum(): AlbumRow {
  let defaults = db.prepare(`SELECT ${ALBUM_COLUMNS} FROM gallery_albums WHERE is_default=1 ORDER BY id ASC`).all() as AlbumRow[];
  if (defaults.length > 1) {
    const keep = defaults[0];
    for (const extra of defaults.slice(1)) {
      db.prepare("UPDATE gallery_albums SET is_default=0 WHERE id=?").run(extra.id);
    }
    defaults = [keep];
  }

  let album = defaults[0];
  if (!album) {
    const byName = db.prepare(
      `SELECT ${ALBUM_COLUMNS} FROM gallery_albums WHERE name = ? COLLATE NOCASE`
    ).get(GENERAL_GALLERY_ALBUM_NAME) as AlbumRow | undefined;
    if (byName) {
      db.prepare("UPDATE gallery_albums SET is_default=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(byName.id);
      album = getAlbumRow(byName.id);
    } else {
      const result = db.prepare(
        "INSERT INTO gallery_albums(name, is_default) VALUES(?, 1)"
      ).run(GENERAL_GALLERY_ALBUM_NAME);
      album = getAlbumRow(Number(result.lastInsertRowid));
    }
  }

  db.prepare("UPDATE gallery_media SET album_id=? WHERE album_id IS NULL").run(album.id);
  return album;
}

ensureDefaultGalleryAlbum();

function posterPublicUrl(videoFilename: string): string | null {
  try {
    const poster = galleryPosterFilename(videoFilename);
    if (!existsSync(join(galleryDir, poster))) return null;
    return `/api/media/gallery/${poster}`;
  } catch {
    return null;
  }
}

function albumCoverUrl(filename: string, mediaType: string): string | null {
  if (mediaType === "video") return posterPublicUrl(filename);
  return `/api/media/gallery/${filename}`;
}

function albumToJson(row: AlbumRow): GalleryAlbum {
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM gallery_media WHERE album_id=?").get(row.id) as { c: number };
  const cover = db.prepare(
    `SELECT filename, media_type FROM gallery_media WHERE album_id=? ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(row.id) as { filename: string; media_type: string } | undefined;
  return {
    id: row.id,
    name: row.name,
    is_default: row.is_default ? 1 : 0,
    event_id: row.event_id == null ? null : Number(row.event_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    media_count: countRow.c,
    cover_url: cover ? albumCoverUrl(cover.filename, cover.media_type) : null
  };
}

export function mediaRowToJson(row: MediaRow): GalleryMedia {
  const albumId = row.album_id ?? ensureDefaultGalleryAlbum().id;
  const mediaType = row.media_type as GalleryMediaType;
  const base: GalleryMedia = {
    id: row.id,
    filename: row.filename,
    media_type: mediaType,
    caption: row.caption,
    uploaded_by: row.uploaded_by,
    album_id: albumId,
    created_at: row.created_at,
    url: `/api/media/gallery/${row.filename}`,
    download_url: `/api/media/gallery/${row.filename}/download`
  };
  if (mediaType === "video") {
    base.poster_url = posterPublicUrl(row.filename);
  }
  return base;
}

export function listGalleryAlbums(): GalleryAlbum[] {
  ensureDefaultGalleryAlbum();
  const rows = db.prepare(
    `SELECT ${ALBUM_COLUMNS} FROM gallery_albums
     ORDER BY is_default DESC, name COLLATE NOCASE ASC, id ASC`
  ).all() as AlbumRow[];
  return rows.map(albumToJson);
}

export function getGalleryAlbum(id: number): GalleryAlbum {
  ensureDefaultGalleryAlbum();
  return albumToJson(getAlbumRow(id));
}

export function createGalleryAlbum(input: Record<string, unknown>): GalleryAlbum {
  ensureDefaultGalleryAlbum();
  const name = normalizeAlbumName(input.name);
  if (albumExistsCaseInsensitive(name)) {
    throw new GalleryError("An album with that name already exists");
  }
  const result = db.prepare(
    "INSERT INTO gallery_albums(name, is_default, event_id) VALUES(?, 0, NULL)"
  ).run(name);
  return albumToJson(getAlbumRow(Number(result.lastInsertRowid)));
}

export function renameGalleryAlbum(id: number, input: Record<string, unknown>): GalleryAlbum {
  ensureDefaultGalleryAlbum();
  const album = getAlbumRow(id);
  if (album.is_default) {
    throw new GalleryError("The General album cannot be renamed");
  }
  const name = normalizeAlbumName(input.name);
  if (albumExistsCaseInsensitive(name, id)) {
    throw new GalleryError("An album with that name already exists");
  }
  db.prepare(
    "UPDATE gallery_albums SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).run(name, id);
  return albumToJson(getAlbumRow(id));
}

/**
 * Delete an album after moving its media to the General/default album.
 * The default album itself cannot be deleted.
 */
export function deleteGalleryAlbum(id: number): { ok: true; moved: number; destination_album_id: number } {
  const general = ensureDefaultGalleryAlbum();
  const album = getAlbumRow(id);
  if (album.is_default || album.id === general.id) {
    throw new GalleryError("The General album cannot be deleted");
  }

  const moved = db.transaction(() => {
    const result = db.prepare(
      "UPDATE gallery_media SET album_id=? WHERE album_id=?"
    ).run(general.id, id);
    db.prepare("DELETE FROM gallery_albums WHERE id=?").run(id);
    return result.changes;
  })();

  return { ok: true, moved, destination_album_id: general.id };
}

export function listGallery(albumId?: number | null): GalleryMedia[] {
  ensureDefaultGalleryAlbum();
  if (albumId == null) {
    const rows = db.prepare(
      `SELECT ${MEDIA_COLUMNS} FROM gallery_media ORDER BY created_at DESC, id DESC`
    ).all() as MediaRow[];
    return rows.map(mediaRowToJson);
  }
  getAlbumRow(albumId);
  const rows = db.prepare(
    `SELECT ${MEDIA_COLUMNS} FROM gallery_media WHERE album_id=? ORDER BY created_at DESC, id DESC`
  ).all(albumId) as MediaRow[];
  return rows.map(mediaRowToJson);
}

function resolveUploadAlbumId(raw?: unknown): number {
  const general = ensureDefaultGalleryAlbum();
  if (raw == null || raw === "") return general.id;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return general.id;
  const row = db.prepare("SELECT id FROM gallery_albums WHERE id=?").get(id) as { id: number } | undefined;
  return row?.id ?? general.id;
}

/** Stream a file's bytes through SHA-256 without loading it into memory. */
async function hashGalleryFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex").slice(0, 32);
}

/** Read a bounded prefix for magic-byte sniffing without buffering the whole file. */
async function readGalleryPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Single authoritative persistence path for both the small buffer upload and the
 * large streamed Keeper upload, so the two can never drift. Validates media from a
 * completed temp file (bounded prefix + streamed hash), finalizes with an atomic
 * rename into Gallery storage, generates the PR143 poster for videos, and inserts
 * the DB row last. A failed insert removes any file this upload alone created, so a
 * broken row never points at an incomplete or orphaned file.
 */
async function persistGalleryTempFile(input: {
  tempPath: string;
  contentType?: string | null;
  originalName?: string;
  caption?: string;
  uploadedBy?: string;
  albumId?: unknown;
}): Promise<GalleryMedia> {
  const { size } = await stat(input.tempPath);
  if (size <= 0) throw new GalleryError("Pick a photo or video first");

  const prefix = await readGalleryPrefix(input.tempPath, GALLERY_SNIFF_BYTES);
  const type = resolveType(prefix, input.contentType, input.originalName);
  const extension = IMAGE_EXTENSIONS[type] ?? VIDEO_EXTENSIONS[type];
  if (!extension) {
    throw new GalleryError("Use a JPEG, PNG, or WebP photo, or an MP4, WebM, or MOV video");
  }
  const mediaType: GalleryMediaType = IMAGE_EXTENSIONS[type] ? "image" : "video";
  const albumId = resolveUploadAlbumId(input.albumId);

  const hash = await hashGalleryFile(input.tempPath);
  const filename = `${hash}${extension}`;
  const target = join(galleryDir, filename);

  let createdTarget = false;
  if (existsSync(target)) {
    // Identical bytes already stored — drop the temp and reuse the durable file (dedup).
    await unlink(input.tempPath).catch(() => {});
  } else {
    // Same-filesystem rename is atomic: the durable file never appears half-written.
    await rename(input.tempPath, target);
    createdTarget = true;
  }

  if (mediaType === "video") {
    const posterPath = join(galleryDir, galleryPosterFilename(filename));
    if (!existsSync(posterPath)) {
      // PR143: poster generation is best-effort; a valid video still saves if ffmpeg fails.
      await generateGalleryVideoPoster({
        galleryDir,
        videoFilename: filename,
        log: (message) => console.warn(message),
      });
    }
  }

  try {
    const caption = clipText(input.caption ?? "", MAX_GALLERY_CAPTION);
    const uploadedBy = clipText(input.uploadedBy ?? "", MAX_PATRON_NAME) || "Patron";
    const result = db.prepare(
      `INSERT INTO gallery_media(filename, media_type, caption, uploaded_by, album_id)
       VALUES(?,?,?,?,?)`
    ).run(filename, mediaType, caption, uploadedBy, albumId);

    const row = db.prepare(
      `SELECT ${MEDIA_COLUMNS} FROM gallery_media WHERE id=?`
    ).get(result.lastInsertRowid) as MediaRow;
    return mediaRowToJson(row);
  } catch (error) {
    // A failed insert must not leave an orphan file that only this upload created.
    if (createdTarget) {
      await unlink(target).catch(() => {});
      try {
        const poster = join(galleryDir, galleryPosterFilename(filename));
        if (existsSync(poster)) await unlink(poster);
      } catch {
        // Best-effort; there is no DB row to reference these files.
      }
    }
    throw error;
  }
}

/**
 * Small-upload / test path. Buffers are acceptable here; the file is written to a
 * temp path and finalized through the shared persistence core. `maxBytes` lets the
 * caller apply the effective (Guest or Keeper) ceiling; it defaults to the Guest limit.
 */
export async function saveGalleryUpload(input: {
  buffer: Buffer;
  contentType?: string | null;
  originalName?: string;
  caption?: string;
  uploadedBy?: string;
  albumId?: unknown;
  maxBytes?: number;
}): Promise<GalleryMedia> {
  if (!input.buffer.length) throw new GalleryError("Pick a photo or video first");
  const limit = input.maxBytes ?? MAX_GALLERY_BYTES;
  if (input.buffer.length > limit) {
    throw new GalleryError(galleryOversizeMessage(limit, limit > MAX_GALLERY_BYTES), 413);
  }

  const tempPath = join(galleryTmpDir, `buf-${randomBytes(16).toString("hex")}.part`);
  await writeFile(tempPath, input.buffer);
  try {
    return await persistGalleryTempFile({
      tempPath,
      contentType: input.contentType,
      originalName: input.originalName,
      caption: input.caption,
      uploadedBy: input.uploadedBy,
      albumId: input.albumId,
    });
  } finally {
    if (existsSync(tempPath)) {
      await unlink(tempPath).catch(() => {});
    }
  }
}

/**
 * Large Keeper upload path. Streams multipart data straight to a temp file under
 * the Gallery filesystem, enforcing `byteCeiling` as it goes (never buffering the
 * whole file), then finalizes through the shared persistence core. Partial temp
 * files are always removed on failure, and an over-limit or interrupted upload
 * never creates a Gallery row.
 */
export async function saveGalleryUploadFromStream(input: {
  stream: Readable;
  byteCeiling: number;
  oversizeMessage: string;
  contentType?: string | null;
  originalName?: string;
  wasTruncated?: () => boolean;
  readFields?: () => { caption?: string; uploadedBy?: string; albumId?: unknown };
}): Promise<GalleryMedia> {
  const tempPath = join(galleryTmpDir, `up-${randomBytes(16).toString("hex")}.part`);
  let written = 0;

  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > input.byteCeiling) {
        cb(new GalleryError(input.oversizeMessage, 413));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(input.stream, limiter, createWriteStream(tempPath));
    // The multipart parser also caps the file; a truncated stream means it tripped first.
    if (input.wasTruncated?.()) {
      throw new GalleryError(input.oversizeMessage, 413);
    }
    if (written <= 0) throw new GalleryError("Pick a photo or video first");

    const fields = input.readFields?.() ?? {};
    return await persistGalleryTempFile({
      tempPath,
      contentType: input.contentType,
      originalName: input.originalName,
      caption: fields.caption,
      uploadedBy: fields.uploadedBy,
      albumId: fields.albumId,
    });
  } finally {
    if (existsSync(tempPath)) {
      await unlink(tempPath).catch(() => {});
    }
  }
}

/**
 * Bounded, idempotent poster backfill for legacy videos missing a sibling WebP.
 * Safe to call at boot; does not run on guest list requests.
 *
 * Pages through video rows by id and only counts missing-poster work against
 * `limit`, so early videos that already have posters cannot starve later ones.
 */
export async function backfillMissingGalleryPosters(opts?: {
  limit?: number;
  log?: (message: string) => void;
}): Promise<{ attempted: number; generated: number }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 40, 100));
  const pageSize = Math.max(limit * 2, 50);
  let attempted = 0;
  let generated = 0;
  let afterId = 0;
  const seenFilenames = new Set<string>();

  while (attempted < limit) {
    const rows = db
      .prepare(
        `SELECT id, filename FROM gallery_media
         WHERE media_type = 'video' AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(afterId, pageSize) as { id: number; filename: string }[];

    if (rows.length === 0) break;

    for (const row of rows) {
      afterId = row.id;
      if (seenFilenames.has(row.filename)) continue;
      seenFilenames.add(row.filename);

      let posterName: string;
      try {
        posterName = galleryPosterFilename(row.filename);
      } catch {
        continue;
      }
      if (existsSync(join(galleryDir, posterName))) continue;
      if (!existsSync(join(galleryDir, row.filename))) continue;

      attempted += 1;
      const ok = await ensureGalleryVideoPoster({
        galleryDir,
        videoFilename: row.filename,
        log: opts?.log,
      });
      if (ok) generated += 1;
      if (attempted >= limit) break;
    }
  }

  return { attempted, generated };
}

export function moveGalleryMedia(mediaId: number, albumId: number): GalleryMedia {
  ensureDefaultGalleryAlbum();
  getAlbumRow(albumId);
  const existing = db.prepare(`SELECT ${MEDIA_COLUMNS} FROM gallery_media WHERE id=?`).get(mediaId) as MediaRow | undefined;
  if (!existing) throw new GalleryError("That item is already gone", 404);
  db.prepare("UPDATE gallery_media SET album_id=? WHERE id=?").run(albumId, mediaId);
  const row = db.prepare(`SELECT ${MEDIA_COLUMNS} FROM gallery_media WHERE id=?`).get(mediaId) as MediaRow;
  return mediaRowToJson(row);
}

export function deleteGalleryMedia(id: number) {
  const row = db.prepare("SELECT filename, media_type FROM gallery_media WHERE id=?").get(id) as
    | { filename: string; media_type: string }
    | undefined;
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
    if (row.media_type === "video") {
      try {
        const poster = join(galleryDir, galleryPosterFilename(row.filename));
        if (existsSync(poster)) unlinkSync(poster);
      } catch {
        // Poster cleanup is best-effort; the DB row is already gone.
      }
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
