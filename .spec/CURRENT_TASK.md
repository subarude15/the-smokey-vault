# Current task

**Status: active — PR128**

**PR128 — Gallery bulk photo upload for Guests and Keepers**

## Objective

1. Guests and Keepers can multi-select photos/clips from the device library and upload them as a batch.
2. Each file posts independently to the existing `POST /api/gallery/upload` contract with clear per-file progress and failure isolation.
3. Camera capture remains single-file; oversized/invalid files do not discard valid selections; failed items can be retried.

## Boundaries

1. Reuse `saveGalleryUpload` and the public single-upload route; do not add a bulk multipart endpoint or ZIP ingestion.
2. Keep upload logic local to Gallery (`GalleryPage` + a tiny pure helper module if useful for tests).
3. Shared uploaded-by + caption for the whole batch; no per-photo captions.
4. Preserve Guest/Keeper parity, listing, lightbox, download, and Keeper delete.

## Non-goals

- Cloud photo imports, albums, face recognition, tagging, EXIF identity, filters, moderation
- Per-file caption editing, new auth model, Gallery persistence rewrite
- PR129 cocktail imagery, PR130 landing cleanup, PR131 albums
