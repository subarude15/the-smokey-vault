# Smokey Vault — Current Development State

Last updated: 2026-09-08

## Current position

Most recently completed:
- **PR145** — Cocktail recipe completeness, cocktail photo backfill, and Keeper build identifier. Built-in cocktails now render deterministic, practical preparation steps (`resolveCocktailInstructions` / `buildCocktailSteps` in `client/src/cocktail-instructions.ts`) derived from their method/glassware/garnish instead of a bare technique label; the short method stays as metadata, and AI/custom recipes with real prose/numbered instructions are used as-is. `backfillMissingCocktailImages` (in `src/cocktail_image.ts`) fills missing built-in cocktail photos in bounded batches at boot via the existing safe discovery, never overwriting Keeper/custom images. A lightweight build identifier (`src/build-info.ts`, `GET /api/admin/build`) appears in Keeper Settings.

Currently working on:
- None.

Next planned:
- **PR146 — Gallery comments + up/down voting** (`ROADMAP.md` Track C).

## Recent architectural decisions

- Guest inventory/enrichment responses stay server-allowlisted (`guest-inventory-response`); coarse availability only.
- Shared `ImageField` / `images` media path is the default for Keeper uploads; do not add parallel upload systems per feature.
- Event photo framing is event-only metadata (`image_focal_x` / `image_focal_y` / `image_zoom`) applied with CSS — never bake crop into the uploaded file via `ImageField`.
- Guest landing CTAs that deep-link to tab-gated pages must reuse `pageEnabled` / `PAGE_TAB` (see `landingFeedbackCtaEnabled`) so Overview and nav cannot drift.
- Gallery video tiles/covers use persisted lightweight posters; original videos load only in the viewer/download path; poster cleanup follows Gallery media ownership/reference semantics.
- Gallery upload limits are centralized in `speakeasy-shared` and applied per media type: photos are capped at 150 MB for all roles, and only videos use the larger Keeper ceiling. The per-type ceiling is enforced server-side on the sniffed media type (not client `File.size`/Content-Length/filename). Large Keeper videos stream to `galleryDir/tmp` and finalize via one shared temp-file persistence path (atomic rename, no full-file Buffer); small uploads and the streamed path share that core so they cannot drift.
- Built-in cocktail instructions are generated deterministically at render time from the seed's method/glassware/garnish (no DB migration; existing prod rows benefit immediately). Generation only fires when `method` is a bare technique label or empty; rich prose/numbered instructions (AI/custom) are preserved and never overwritten. The short method label stays visible as metadata (recipe header + resolver's `methodLabel`).
- Cocktail photos use one shared discovery path: the Keeper "Find photo" action and the bounded boot backfill both call `findCocktailImage` (fill-missing only; localizes to `/api/media/...`; custom cocktails skipped). The boot backfill advances a persisted cursor (`cocktailImageBackfillCursor`) and wraps around, so persistent no-results near the start cannot starve later cocktails. No parallel cocktail image system.
- Built-in cocktail method-label detection uses an explicit technique allowlist (`isCocktailMethodLabel`), so only genuine short labels (Build/Shake/Stir/…) become generated steps; real short prose (e.g. "Shake with ice and strain into a coupe.") is preserved.
- Build/version identifier is derived from build metadata injected at image build time (`BUILD_DATE`/`BUILD_PR`/`GIT_SHA`) — no committed milestone constant to bump per PR. `docker-publish.yml` stamps the date, parses the PR number from the merge commit, and passes `github.sha`; local/dev falls back deterministically to today's date with a `.dev` marker. Exposed Keeper-only via `GET /api/admin/build` (`src/build-info.ts`).
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
- Draft **#121** branding docs remain deferred until PR147.
- Ops hardening (Watchtower scope, ownership expansion) stays evidence-driven and must not displace the next product PR.

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
