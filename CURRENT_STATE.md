# Smokey Vault — Current Development State

Last updated: 2026-09-08

## Current position

Most recently completed:
- **PR144** — Keeper large-video upload path. Guests keep the 150 MB ceiling; authenticated Keepers get a larger, env-tunable limit (`KEEPER_GALLERY_MAX_VIDEO_MB`, default ~1 GiB, bounded fallback) chosen server-side from authorization. Large uploads stream to a temp file under the Gallery filesystem and finalize with an atomic rename through one shared persistence path — never buffering the whole file — with partial/failed uploads leaving no temp file or DB row. PR143 posters, magic-byte validation, dedup, and reference-aware cleanup are preserved; oversized uploads return 413 with human-readable copy.

Currently working on:
- None.

Next planned:
- **PR145 — Gallery comments + up/down voting** (`ROADMAP.md` Track C).

## Recent architectural decisions

- Guest inventory/enrichment responses stay server-allowlisted (`guest-inventory-response`); coarse availability only.
- Shared `ImageField` / `images` media path is the default for Keeper uploads; do not add parallel upload systems per feature.
- Event photo framing is event-only metadata (`image_focal_x` / `image_focal_y` / `image_zoom`) applied with CSS — never bake crop into the uploaded file via `ImageField`.
- Guest landing CTAs that deep-link to tab-gated pages must reuse `pageEnabled` / `PAGE_TAB` (see `landingFeedbackCtaEnabled`) so Overview and nav cannot drift.
- Gallery video tiles/covers use persisted lightweight posters; original videos load only in the viewer/download path; poster cleanup follows Gallery media ownership/reference semantics.
- Gallery upload limits are centralized in `speakeasy-shared` (Guest vs Keeper); the effective ceiling is decided server-side by authorization (never client `File.size`/Content-Length). Large Keeper videos stream to `galleryDir/tmp` and finalize via one shared temp-file persistence path (atomic rename, no full-file Buffer); small uploads and the streamed path share that core so they cannot drift.
- Absolute `/api/media/images/...` URLs collapse to relative paths only when the origin matches the app/request; foreign CDNs with that path stay remote.
- Upload failure must not call `onChange` with a captured prior value (avoids racing a newer successful image).
- Commercial tap enrichment reuses exact vault packaged-beer images; homebrew taps stay excluded; Keeper-owned images are not auto-overwritten.
- Appearance support is Light + Dark only (PR127).
- App routing remains state-based in `App.tsx` (no React Router for primary navigation).
- GitHub PR numbers are authoritative for roadmap numbering; when a docs/tooling PR consumes a number, later planned product PRs shift forward (PR141 chore → feedback CTA visibility is PR142).
- `.env` is optional for boot (`SESSION_SECRET` auto-generates into the vault DB); `KEEPER_GALLERY_MAX_VIDEO_MB` tunes the Keeper video ceiling without an image rebuild.

## Known issues / follow-ups

- Evidence-only beer discovery: open a focused PR only when production shows a reproducible gap (see Track A).
- Keeper large uploads write temp files under `galleryDir/tmp` so finalization is a same-filesystem atomic rename; keep temp storage on the Gallery/data filesystem to avoid cross-device rename failure.
- Draft **#121** branding docs remain deferred until PR146.
- Ops hardening (Watchtower scope, ownership expansion) stays evidence-driven and must not displace the next product PR.

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
