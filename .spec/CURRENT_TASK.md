# Current task

**Status: idle**

PR146 complete — Gallery comments + up/down voting:
- Guests comment and cast one up/down vote from the Gallery lightbox via a compact social section (`client/src/GallerySocial.tsx`); Keepers get per-comment removal in the same view.
- Server logic in `src/gallery-social.ts`: normalized `gallery_comments` + `gallery_votes` tables (media-scoped indexes, `UNIQUE(media_id, voter_key)`), reachable via `GET /api/gallery/:id/social`, `POST /api/gallery/:id/comments`, `DELETE /api/gallery/:id/comments/:commentId` (Keeper), `POST /api/gallery/:id/vote`.
- Duplicate-vote safeguard: `deriveGalleryVoterKey` HMACs the client's existing `smokey-voter` device token plus IP/User-Agent with the session secret; the raw key never leaves the server. Same-direction re-vote toggles off; up↔down reuses the single row.
- Social records use the stable `gallery_media.id`; they are removed transactionally inside `deleteGalleryMedia` and are untouched by album move/rename. Comments are plain text only, trimmed, empty rejected, length-capped server-side; Guest responses never expose voter keys or moderation metadata.

Next planned product work: **PR147 — Visual system / Smokey Barrel branding polish**.
