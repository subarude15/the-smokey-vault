import { createHmac } from "node:crypto";
import { db } from "./db.js";

/**
 * Gallery social layer (PR146): guest comments + up/down voting attached to a
 * Gallery media item by its stable `gallery_media.id`. Records intentionally do
 * NOT reference album_id, filenames, or poster paths, so album move/rename never
 * disturbs interaction and file-dedup never mixes two items' social data.
 *
 * Privacy: the anonymous voter key is derived server-side (HMAC of the durable
 * per-device token, or opaque request context as a fallback, with the session
 * secret) and is never returned to the client. Guest responses expose only what
 * the feature needs — comment author, text, timestamp, and aggregate vote counts
 * plus the caller's own vote. Comments store no voter identity at all.
 */

export const MAX_GALLERY_COMMENT = 500;
export const MAX_GALLERY_COMMENT_AUTHOR = 40;

export class GallerySocialError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type GalleryVoteTally = {
  up: number;
  down: number;
  net: number;
  total: number;
  /** The calling voter's current vote direction, or null. Never a voter key. */
  mine: 1 | -1 | null;
};

/** Guest-safe comment shape. Comments store no voter identity. */
export type GalleryComment = {
  id: number;
  media_id: number;
  author: string;
  body: string;
  created_at: string;
};

export type GallerySocial = {
  votes: GalleryVoteTally;
  comments: GalleryComment[];
};

// Comments store only the minimum needed to display them. They deliberately
// carry no voter/device identity. NOTE: `CREATE TABLE IF NOT EXISTS` never
// alters an existing table, so a database created earlier on this PR branch may
// still have a leftover `voter_key` column. That is safe: the column had a
// `DEFAULT ''`, inserts below omit it (so it receives the empty default), and no
// code reads it — leaving the physical column avoids a risky table rebuild.
db.exec(`
CREATE TABLE IF NOT EXISTS gallery_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL,
  author TEXT NOT NULL DEFAULT 'Patron',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS gallery_comments_media ON gallery_comments(media_id, id);
CREATE TABLE IF NOT EXISTS gallery_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL,
  voter_key TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(media_id, voter_key)
);
CREATE INDEX IF NOT EXISTS gallery_votes_media ON gallery_votes(media_id);
`);

/**
 * Derive an opaque anonymous voter key, keyed with the session secret.
 *
 * The durable per-device token (the client's existing `smokey-voter` localStorage
 * id) is the primary identity: when it is present the key is derived from that
 * token ALONE, so a device stays one voter even if its LAN IP or browser
 * User-Agent changes. Only when no usable device token is supplied do we fall
 * back to a limited request-context key (IP + User-Agent). The two namespaces
 * are prefixed so a device token can never collide with a fallback key.
 *
 * The result is an HMAC digest — the raw token/context is never stored and the
 * key is never returned to the client, so duplicate-vote protection data stays
 * entirely server-side.
 */
export function deriveGalleryVoterKey(
  secret: string,
  parts: { deviceToken?: string; ip?: string; userAgent?: string }
): string {
  const deviceToken = (parts.deviceToken ?? "").trim().slice(0, 200);
  const material = deviceToken
    ? `device\n${deviceToken}`
    : `context\n${(parts.ip ?? "").trim()}\n${(parts.userAgent ?? "").trim().slice(0, 400)}`;
  return createHmac("sha256", secret).update(material).digest("hex");
}

export function galleryMediaExists(mediaId: number): boolean {
  if (!Number.isInteger(mediaId) || mediaId < 1) return false;
  return Boolean(db.prepare("SELECT id FROM gallery_media WHERE id=?").get(mediaId));
}

export function galleryVoteTally(mediaId: number, voterKey?: string): GalleryVoteTally {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down_count
    FROM gallery_votes WHERE media_id=?
  `).get(mediaId) as { up_count: number | null; down_count: number | null };
  let mine: 1 | -1 | null = null;
  if (voterKey) {
    const vote = db.prepare(
      "SELECT value FROM gallery_votes WHERE media_id=? AND voter_key=?"
    ).get(mediaId, voterKey) as { value: number } | undefined;
    if (vote?.value === 1 || vote?.value === -1) mine = vote.value;
  }
  const up = Number(row?.up_count ?? 0);
  const down = Number(row?.down_count ?? 0);
  return { up, down, net: up - down, total: up + down, mine };
}

/**
 * Cast, switch, or clear a vote. One active vote per (media_id, voter_key),
 * enforced by a UNIQUE index. Voting the same direction again toggles it off;
 * up → down updates the existing row (never a second vote).
 */
export function castGalleryVote(mediaId: number, voterKey: string, value: number): GalleryVoteTally {
  if (value !== 1 && value !== -1) throw new GallerySocialError("Vote must be up or down", 400);
  if (!voterKey) throw new GallerySocialError("Missing voter", 400);
  if (!galleryMediaExists(mediaId)) throw new GallerySocialError("That item is already gone", 404);
  const existing = db.prepare(
    "SELECT value FROM gallery_votes WHERE media_id=? AND voter_key=?"
  ).get(mediaId, voterKey) as { value: number } | undefined;
  if (existing?.value === value) {
    db.prepare("DELETE FROM gallery_votes WHERE media_id=? AND voter_key=?").run(mediaId, voterKey);
  } else if (existing) {
    db.prepare("UPDATE gallery_votes SET value=? WHERE media_id=? AND voter_key=?").run(value, mediaId, voterKey);
  } else {
    db.prepare("INSERT INTO gallery_votes(media_id, voter_key, value) VALUES(?, ?, ?)").run(mediaId, voterKey, value);
  }
  return galleryVoteTally(mediaId, voterKey);
}

/** Comments oldest → newest for a stable in-place read in the lightbox. */
export function listGalleryComments(mediaId: number): GalleryComment[] {
  return db.prepare(
    "SELECT id, media_id, author, body, created_at FROM gallery_comments WHERE media_id=? ORDER BY id ASC"
  ).all(mediaId) as GalleryComment[];
}

export function addGalleryComment(
  mediaId: number,
  input: { body: string; author?: string }
): GalleryComment {
  const text = (input.body ?? "").trim();
  if (!text) throw new GallerySocialError("Write a short comment", 400);
  if (text.length > MAX_GALLERY_COMMENT) {
    throw new GallerySocialError(`Comment must be ${MAX_GALLERY_COMMENT} characters or fewer`, 400);
  }
  const author = (input.author ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_GALLERY_COMMENT_AUTHOR) || "Patron";
  if (!galleryMediaExists(mediaId)) throw new GallerySocialError("That item is already gone", 404);
  const result = db.prepare(
    "INSERT INTO gallery_comments(media_id, author, body) VALUES(?, ?, ?)"
  ).run(mediaId, author, text);
  return db.prepare(
    "SELECT id, media_id, author, body, created_at FROM gallery_comments WHERE id=?"
  ).get(result.lastInsertRowid) as GalleryComment;
}

/** Keeper moderation: delete one comment, scoped to its media item. */
export function deleteGalleryComment(mediaId: number, commentId: number): boolean {
  const result = db.prepare("DELETE FROM gallery_comments WHERE id=? AND media_id=?").run(commentId, mediaId);
  return result.changes > 0;
}

/** Cleanup helper called inside the media-delete transaction. */
export function deleteGallerySocialForMedia(mediaId: number) {
  db.prepare("DELETE FROM gallery_comments WHERE media_id=?").run(mediaId);
  db.prepare("DELETE FROM gallery_votes WHERE media_id=?").run(mediaId);
}

export function getGallerySocial(mediaId: number, voterKey?: string): GallerySocial {
  return {
    votes: galleryVoteTally(mediaId, voterKey),
    comments: listGalleryComments(mediaId)
  };
}
