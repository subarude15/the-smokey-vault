# Smokey Vault — Current Development State

Last updated: 2026-09-09

## Current position

Most recently completed:
- **PR154** — Cocktail image discovery reliability. Extracted a pure identity model (`src/cocktail-image-identity.ts`): exact normalized name (strongest) → base-spirit alias confirmed by the drink's own ingredients (e.g. Basil Smash ↔ Gin Basil Smash when the recipe has gin) → reject everything else. Any meaningful modifier token (Strawberry/Smoked/…) or an unconfirmed/different base spirit rejects the candidate; a candidate whose ingredients add a flavor variant absent from the target is also rejected. `src/cocktail_image.ts` now runs a bounded 3-query plan (exact → alias → ingredient-assisted, deduped), classifies JSON-LD/heading/title identity with ingredient evidence, and returns staged Keeper diagnostics (`search_miss` / `identity_rejected` / `no_page_image` / `localize_failed` / `search_failed`) surfaced via `cocktailImageDiscoveryMessage`. All PR129 safety (fill-missing ownership, rejected-host denylist, mandatory localization, no thumbnail hotlinking) and the PR145 backfill are preserved; regression fixtures cover the Basil Smash accept and Strawberry/Raspberry/Whiskey rejects.

Previously completed:
- **PR153** — Remaining shell and chrome polish. Desktop/tablet rail shell now gives `main` the sole page-scroll path (`height: 100dvh` shell, `overflow-y: auto` on `main`; sidebar nav may still scroll when destinations exceed the viewport). Phone More sheet gained an explicit Close control (44px target, accessible name) alongside backdrop / Escape / destination dismissal with focus restore. Theme toggle uses `themeToggleLabel()` so assistive tech hears “Switch to Light theme” / “Switch to Dark theme”. Mobile horizontal overflow / stray shell scrollbar chrome did not reproduce on current `main` at ~390px, so no speculative scrollbar CSS was added. No navigation IA, Guest/Keeper privacy, backend/API/schema, or Light/Dark theme-semantic changes.

Previously completed:
- **PR152** — Bottle Library flavor discovery and filter cleanup. Client-only Flavor vocabulary/search helpers (`spirit-flavors.ts`, `spirit-search.ts`) and simplified Family · Flavor · Availability filters.

Previously completed:
- **PR151** — Bottle Library media and loading-state polish.
- **PR150** — Overview hierarchy and responsive stat redesign.
- **PR149** — Guest navigation, terminology, and Smokey Barrel naming (`NAV_LABELS` / `destinationTitle` in `shell-nav.ts`).
- **PR148** — Live-use Guest/Keeper UX audit + focused cleanup.

Currently working on:
- Idle after PR153.

Next planned:
- No numbered item queued. The roadmap returns to evidence-driven Brewery Lab / live-use follow-up (`ROADMAP.md` Track C); open a new PR number only when a concrete issue is identified.

## Recent architectural decisions

- Cocktail image identity (PR154) lives in the pure `src/cocktail-image-identity.ts`: exact name → base-spirit alias confirmed by the drink's own ingredients → reject. Any meaningful name modifier or unconfirmed/different base spirit rejects; extend the bounded vocab (base spirits, whiskey-family, modifier ingredients) rather than loosening the gate. `src/cocktail_image.ts` keeps all PR129 safety rules and the PR145 backfill; discovery returns staged diagnostics (never a single generic no-result).
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
- Appearance support is Light + Dark only (PR127). Theme toggle accessible naming is action-oriented via `themeToggleLabel` (PR153).
- App routing remains state-based in `App.tsx` (no React Router for primary navigation).
- Rail shell scroll ownership (PR153): viewport-locked `.app-shell` on desktop/tablet landscape; `main` is the page scroller; phone portrait keeps document scroll.
- GitHub PR numbers are authoritative for roadmap numbering; when a docs/tooling PR consumes a number, later planned product PRs shift forward (PR141 chore → feedback CTA visibility is PR142).
- `.env` is optional for boot (`SESSION_SECRET` auto-generates into the vault DB); `KEEPER_GALLERY_MAX_VIDEO_MB` tunes the Keeper video ceiling without an image rebuild.

## Known issues / follow-ups

- Evidence-only beer discovery: open a focused PR only when production shows a reproducible gap (see Track A).
- Keeper large uploads write temp files under `galleryDir/tmp` so finalization is a same-filesystem atomic rename; keep temp storage on the Gallery/data filesystem to avoid cross-device rename failure.
- Draft **#121** branding docs are superseded by PR147's shipped visual system; keep Light/Dark only and the SB monogram identity.
- Ops hardening (Watchtower scope, ownership expansion) stays evidence-driven and must not displace the next product PR.
- Deferred from PR153: global touch-target expansion; cocktail image discovery (PR154).

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
