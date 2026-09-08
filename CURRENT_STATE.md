# Smokey Vault — Current Development State

Last updated: 2026-09-08

## Current position

Most recently completed:
- **PR143** — Lightweight Gallery video posters. Uploads extract a near-start frame (ffmpeg) and store a compressed WebP sibling beside Gallery media; grids/covers use `poster_url` (or a static fallback) so browsing does not fetch video payloads. Original playback/download stays on the media URL. Poster cleanup follows shared filename reference counts; bounded boot backfill covers legacy rows. Runtime image installs `ffmpeg`.

Currently working on:
- None.

Next planned:
- **PR144 — Keeper large-video upload path** (`ROADMAP.md` Track C).

## Recent architectural decisions

- Guest inventory/enrichment responses stay server-allowlisted (`guest-inventory-response`); coarse availability only.
- Shared `ImageField` / `images` media path is the default for Keeper uploads; do not add parallel upload systems per feature.
- Event photo framing is event-only metadata (`image_focal_x` / `image_focal_y` / `image_zoom`) applied with CSS — never bake crop into the uploaded file via `ImageField`.
- Guest landing CTAs that deep-link to tab-gated pages must reuse `pageEnabled` / `PAGE_TAB` (see `landingFeedbackCtaEnabled`) so Overview and nav cannot drift.
- Gallery video tiles/covers use persisted lightweight posters; original videos load only in the viewer/download path; poster cleanup follows Gallery media ownership/reference semantics.
- Absolute `/api/media/images/...` URLs collapse to relative paths only when the origin matches the app/request; foreign CDNs with that path stay remote.
- Upload failure must not call `onChange` with a captured prior value (avoids racing a newer successful image).
- Commercial tap enrichment reuses exact vault packaged-beer images; homebrew taps stay excluded; Keeper-owned images are not auto-overwritten.
- Appearance support is Light + Dark only (PR127).
- App routing remains state-based in `App.tsx` (no React Router for primary navigation).
- GitHub PR numbers are authoritative for roadmap numbering; when a docs/tooling PR consumes a number, later planned product PRs shift forward (PR141 chore → feedback CTA visibility is PR142).

## Known issues / follow-ups

- Evidence-only beer discovery: open a focused PR only when production shows a reproducible gap (see Track A).
- Draft **#121** branding docs remain deferred until PR146.
- Ops hardening (Watchtower scope, ownership expansion) stays evidence-driven and must not displace the next product PR.

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
