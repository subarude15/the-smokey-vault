# Smokey Vault — Current Development State

Last updated: 2026-09-09

## Current position

Most recently completed:
- **PR149** — Guest navigation, terminology, and Smokey Barrel naming. `client/src/shell-nav.ts` owns one authoritative concise nav-label map (`NAV_LABELS`/`navLabel`) used by the phone bottom bar, desktop/tablet rail, More sheet, and topbar title, plus a paired `DESTINATION_TITLES`/`destinationTitle` for fuller landing headings (Drinks → “What can I make?”, Spirits → “The Bottle Library”). The cocktail “Missing one” tab gained an accessible helper (`MISSING_ONE_HINT`, `client/src/cocktail-card.ts`) with no filter/count change, and the one Guest-visible “Smokey Vault” string became “Smokey Barrel”.

Previously completed:
- **PR148** — Live-use Guest/Keeper UX audit + focused cleanup. Removed the duplicate Guest topbar Keeper PIN shortcut while retaining Keeper access in the rail/More sheet; touch-only devices now reveal generic Keeper card actions without hover; phone toasts clear the fixed bottom nav; stale Admin/Patron Mode copy now uses Guest/Keeper terminology. No API, authentication, privacy, routing, schema, or visual-system changes.

Previously completed:
- **PR147** — Visual system / Smokey Barrel branding polish. The circular blackletter **SB monogram** (hop/scroll filigree) is the primary brand mark, rendered by `client/src/SbMark.tsx` on a warm near-black medallion (artwork is keyed to transparency so the white/gold reads in both themes) and wired into the shell brand, phone topbar, landing hero, favicon, and PWA icons (`client/public/brand/*`). Typography is tokenized (`--font-display` = `Manufacturing Consent` blackletter for brand moments/major headers only, pinned to weight 400 with `font-synthesis:none`; `--font-serif` = Playfair for content titles; `--font-sans` = Outfit for all body/nav/controls/forms/metadata; `--font-mono` = JetBrains Mono only for identifier/code-like values such as the build id, gallery vote counters, and the bulk-import textarea). Palette stays token-driven in `client/src/theme.ts`: Dark unchanged (warm charcoal + copper/amber); Light warmed to bone/smoke with a deeper amber `--accent-2` for small-label contrast. Light + Dark only; no IA/routing changes.

Previously completed:
- **PR146** — Gallery comments + up/down voting. Guests comment and cast one up/down vote from the Gallery lightbox via a compact social section (`client/src/GallerySocial.tsx`, rendered inside the `GalleryPage` lightbox). Server logic lives in `src/gallery-social.ts` (tables `gallery_comments` + `gallery_votes`, media-scoped indexes, `UNIQUE(media_id, voter_key)`); routes are `GET /api/gallery/:id/social`, `POST /api/gallery/:id/comments`, `DELETE /api/gallery/:id/comments/:commentId` (Keeper), `POST /api/gallery/:id/vote`. The anonymous voter key is derived server-side (`deriveGalleryVoterKey`, HMAC keyed with the session secret): the durable `smokey-voter` device token is the primary identity and, when present, the key is derived from that token alone (so a device stays one voter across IP/User-Agent changes), with an opaque IP + User-Agent key used only as a fallback when no device token is supplied. The key is never returned. Comments/votes are cleaned up transactionally inside `deleteGalleryMedia`; album move/rename leaves them untouched.

Previously completed:
- **PR145** — Cocktail recipe completeness, cocktail photo backfill, and Keeper build identifier. Built-in cocktails render deterministic preparation steps (`resolveCocktailInstructions` / `buildCocktailSteps` in `client/src/cocktail-instructions.ts`); `backfillMissingCocktailImages` (`src/cocktail_image.ts`) fills missing built-in cocktail photos at boot; a lightweight build identifier (`src/build-info.ts`, `GET /api/admin/build`) appears in Keeper Settings.

Currently working on:
- **PR150** — Overview hierarchy and responsive stat redesign (branch `cursor/pr150-overview-stat-redesign-00d3`, not yet merged). The six live counts are no longer duplicated as a hero sentence: `overviewHeroCopy` is retired from the client and the hero now shows count-free prose via `overviewHeroLede`. The at-a-glance grid is the sole count surface, extracted into `client/src/OverviewStats.tsx` with a pure `client/src/overview-stats.ts` (`overviewStatDefs`) mapping the existing `/overview` snapshot to six number-first cards (Guest labels On Tap / Off the menu / Spirits / Wine / Beer / Homebrews; Keeper labels unchanged), preserving each metric's tap destination. Loading shows a neutral skeleton (never invented zeroes), genuine zeroes render once loaded, and a failed load shows only the error banner (no zero masquerade). Responsive 2×3 phone / 3×2 tablet+desktop via the existing `stat-grid` tokens; no `/overview` contract, schema, IA, or routing changes.

Next planned:
- Brewery Lab follow-up only if live use proves a specific usability gap (`ROADMAP.md` Track C).

## Recent architectural decisions

- Branding is a single tokenized visual system (PR147): the SB monogram medallion (`SbMark`) is the one brand mark; brand/heading type uses `--font-display` (Manufacturing Consent, weight 400) reserved for brand moments and major headers only (never body/labels/metadata); `--font-sans` (Outfit) is the proportional body/UI font; `--font-mono` (JetBrains Mono) is reserved for identifier/code-like values only. Light + Dark share the same warm whiskey-cellar palette via `theme.ts` tokens. Do not reintroduce removed theme modes, add fake-metal/heavy-texture treatments, use blackletter for dense/body text, or make JetBrains Mono the default UI font.

- Guest inventory/enrichment responses stay server-allowlisted (`guest-inventory-response`); coarse availability only.
- Shared `ImageField` / `images` media path is the default for Keeper uploads; do not add parallel upload systems per feature.
- Event photo framing is event-only metadata (`image_focal_x` / `image_focal_y` / `image_zoom`) applied with CSS — never bake crop into the uploaded file via `ImageField`.
- Guest landing CTAs that deep-link to tab-gated pages must reuse `pageEnabled` / `PAGE_TAB` (see `landingFeedbackCtaEnabled`) so Overview and nav cannot drift.
- Gallery video tiles/covers use persisted lightweight posters; original videos load only in the viewer/download path; poster cleanup follows Gallery media ownership/reference semantics.
- Gallery social records (comments/votes) attach to the stable `gallery_media.id`, never to `album_id`, filenames, or poster paths, so album move/rename and file-dedup never disturb interaction; cleanup runs transactionally with `deleteGalleryMedia`. The anonymous voter key is derived server-side (`deriveGalleryVoterKey`, HMAC keyed with the session secret): the durable client `smokey-voter` device token is the primary identity (key from token alone, so a device stays one voter across IP/UA changes), with an opaque IP+User-Agent fallback only when no token is supplied. Keys/raw context are never returned to Guests. One active vote per `(media_id, voter_key)`; same-direction re-vote toggles off. Comments store no voter/device identity (id, media_id, author, body, created_at only), are plain text (React-escaped), length-capped server-side; Keeper-only removal via `requireAdmin`.
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
- Draft **#121** branding docs are superseded by PR147's shipped visual system; keep Light/Dark only and the SB monogram identity.
- Ops hardening (Watchtower scope, ownership expansion) stays evidence-driven and must not displace the next product PR.

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
