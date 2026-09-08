# The Smokey Vault Roadmap

Short project context for maintainers and coding agents. Update this file when a product PR changes the plan; do not turn it into a changelog.

## Product

The Smokey Vault is a private, self-hosted home-bar appliance for a LAN kiosk and guest phones. It covers:

- Inventory: spirits (Bottle Library), wine cellar, packaged beer, draft taps, and homebrew log
- Guest Mode: digital bar menu / speakeasy portal (cocktails, patrons, events, tip jar, merch, staff, gallery, messages) with no public internet exposure and no payments
- Keeper Mode: PIN unlock for scanning, enrichment, import review, restock, settings, and safe per-item deletion
- Cocktail matcher, substitutions, and optional AI mixologist
- Brewery Lab with optional Brewfather sync

Guest Mode must present the collection safely. Keeper Mode owns mutations and operational metadata.

## Current state

- Production runs from `ghcr.io/subarude15/the-smokey-vault:latest` on a Synology NAS.
- Node.js 24, TypeScript, Fastify, React, and SQLite.
- CI runs the full test suite, production build, catalog runtime checks, and Docker catalog verification.
- Packaged-beer correctness through GitHub PR #119 is merged.
- After #119, Keeper enrichment clarity and bottle-detail visual refinement (plus an EnrichmentPanel Hooks ordering fix) landed as direct commits on `main` before this docs PR.
- PR #122 hardened the Guest API trust boundary with server-side inventory/enrichment redaction.
- PR #124 made Brewery Lab guest-friendly and Keeper-editable while preserving one-way Brewfather ownership of brewing telemetry.
- PR #125 added commercial-tap beer identity/image enrichment with strict official matching, fill-missing Keeper preservation, and explicit Brewery Lab/homebrew exclusion.
- PR #126 added Keeper event editing plus stable guest-facing event deep links with Web Share / copy-link fallback and server-side draft protection.
- Draft PR #53 was reviewed and closed unmerged as superseded: its Keeper enrichment-action product intent remains useful, but its parallel `enrichment_field_overrides` architecture is obsolete against current ownership, entity allowlists, queue controls, and deletion cleanup.
- Verified production cases:
  - Dirt wolf: official style, ABV, notes, and image found.
  - Yuengling Traditional Lager: official notes and image found; no synthetic proof or 750 ml metadata.
  - Ectogasm: no authoritative Drekker product page found, so the pipeline correctly returns no official result.

## Non-negotiable rules

- Preserve user/Keeper-owned values unless the user edits them.
- Accept official product data only after strict exact/strong identity checks.
- Never weaken source provenance or network-safety rules to make a lookup pass.
- Packaged beer does not require or derive proof, generic `volume_ml`, origin, or TTB ID.
- Canonical barcodes must pass GTIN-8/12/13/14 checksum validation; never invent missing digits.
- Keep packaged beer out of the spirits table and Bottle Library.
- Deletion stays per-item, authenticated, transactional, and cleanup-aware. No bulk purge.
- Missing authoritative data is a valid result, not permission to guess.

## Completed foundation

- PR105–108: official-beer browser smoke support, deterministic paths, and extraction.
- PR109–112: ownership-safe official repair, per-item queue controls, sequencing, and legacy beer audit.
- PR113: packaged-beer discovery, metadata semantics, cache safety, and GTIN validation.
- PR114–116: safe per-item deletion, cleanup preview, and Bottle Library separation.
- PR117–119: cross-platform tests, image-test isolation, and Node 24 GitHub Actions.
- Post-#119 on `main`: Keeper enrichment clarity, bottle-detail visual refinement, and EnrichmentPanel Hooks fix (direct commits, not separate GitHub PRs at the time).
- PR122 — Server-side Guest inventory / enrichment redaction (API trust boundary; coarse `out_of_stock` only).
- PR53 decision — stale draft closed unmerged; do not resurrect its parallel override architecture. Rebuild only the useful Keeper interaction on current `main`.
- PR123 — Keeper enrichment actions on current architecture (rerun/retry, ownership-safe verify for packaged-beer ABV/style, resolvable conflict keep/accept without `enrichment_field_overrides`).
- PR97 — Angel’s Share theme and guest availability carve-out merged. The availability behavior remains intentional; the Angel’s Share visual theme itself is scheduled for removal in PR127.
- PR124 — Brewery Lab guest-friendly detail/editor experience, Keeper-owned presentation fields/images, and Brewfather-safe sync ownership.
- PR125 — Commercial tap beer enrichment using official packaged-beer identity/image discovery, strict homebrew exclusion, and Keeper-safe fill-missing updates.
- PR126 — Keeper event editing, published-event deep links, guest-safe event detail access, and Web Share / copy-link behavior.

## Next work

Stability-first, but prioritize concrete product usability problems observed in the live bar. Prefer small, testable PRs. Do not open speculative discovery features.

### Track A — Evidence-only discovery

Do not pre-plan official-beer discovery work. Open a focused PR only when a fresh production case proves a reproducible gap. Ectogasm alone is not a bug while Drekker publishes no authoritative product page.

### Track B — Hardening (planned)

Priority order:

1. **Scope Watchtower** on the NAS compose (labels / `WATCHTOWER_LABEL_ENABLE`) so it cannot recreate unrelated containers.
2. **Client 401 → clear Keeper session** when the bearer expires, instead of waiting for idle lock alone.
3. **Ownership expansion only when a real overwrite bug appears** — Durable ownership today is strongest for packaged-beer ABV/category. Do not start a large enrichment redesign for polish.
4. **Broader conflict verification** — Identity `product_type` and non-ownership metadata verification remain deferred until durable semantics exist without a parallel override table.

### Track C — Product usability (next)

These are explicitly desired near-term product improvements based on real household use.

1. **PR127 — Simplify appearance to Light + Dark only.**
   - Remove Punk and Angel’s Share from selectable themes and runtime theme handling.
   - Remove Angel’s Share-specific CSS/imports, query-param preview behavior, theme preset data, docs, and tests that only exist for that visual skin.
   - Remove Punk-specific styling/preset behavior as well.
   - Preserve all non-theme product behavior introduced alongside PR97, especially guest-safe availability percentages/gauges; those are product behavior, not part of the theme rollback.
   - Existing persisted `theme` values of `punk` or `angels` must migrate/fallback safely to a supported theme rather than breaking the app.
   - Final supported appearance choices: `light` and `dark` only.
   - This is cleanup/simplification, not a new branding exercise.

2. **PR128 — Gallery bulk photo upload for Guests and Keepers.**
   - Extend the existing public gallery upload flow from one media file at a time to multi-select / bulk photo upload.
   - Keep guest uploads allowed exactly as today; Keeper does not need a separate gallery storage path.
   - Support selecting many photos in one action and upload them with clear per-file progress/success/failure feedback so one bad file does not discard the rest of the batch.
   - Reuse `saveGalleryUpload`, existing media-type validation, size limits, filenames, gallery persistence, and public upload safety rules.
   - Prefer repeated bounded uploads or a narrowly designed batch endpoint; do not introduce archive/ZIP ingestion unless there is a demonstrated need.
   - Preserve existing single-upload compatibility and Keeper delete controls.
   - Mobile photo-picker UX matters: multi-select from an iPhone/Android photo library should be a first-class path.
   - Do not add face recognition, automatic tagging, or cloud photo-service integrations in this PR.

3. **PR129 — Cocktail recipe-card imagery.**
   - Cocktails already support `image_url`; improve coverage by finding a useful cocktail image when a recipe has no image.
   - First reuse images from an imported recipe’s authoritative/source page when available and safe; do not overwrite an existing Keeper/imported cocktail image.
   - For built-in/manual recipes with no source image, investigate a conservative image-discovery path using cocktail name + recipe identity. Prefer authoritative recipe/original-source imagery where it can be tied confidently to that exact drink.
   - Do not use an unrelated stock image simply because it looks like the same cocktail style.
   - Localize accepted remote images using the existing image persistence/safety infrastructure.
   - Add a per-cocktail Keeper action (for example “Find photo”) rather than bulk-changing the whole recipe library without review.
   - Guest recipe cards/detail views should naturally render the discovered/localized image through the existing `image_url` field.
   - No new generic image-enrichment platform unless repository inspection proves a small reusable helper is genuinely needed.

4. **PR130 — Remove duplicate Mixologist landing card.**
   - `What Can I Make?` and `Ask the Mixologist` already share the same unified cocktail discovery page.
   - Remove the redundant standalone `Ask the Mixologist` feature card from the main guest landing page and keep `What Can I Make?` as the single entry point.
   - Preserve the Mixologist panel/functionality inside the unified cocktail page and retain any useful `mixologist` → `cocktails` compatibility alias.
   - Keep this as a small landing-page cleanup; do not redesign cocktail discovery or the home page.

5. **Brewery Lab follow-up only if live use proves a specific usability gap.**
   - PR124 established guest-friendly presentation, Keeper-owned editorial fields/images, and Brewfather-safe sync ownership.
   - Do not immediately expand Brewery Lab architecture for polish; use Nick’s real usage to identify the next concrete issue.

## Open PR status

- **#121** Google Stitch `DESIGN.md` — draft branding/theme documentation; intentionally deferred while appearance is being simplified to Light/Dark only.
- **#78** Agentage memory MCP — draft tooling only; not product roadmap.
- **#53** Enrichment review actions — closed unmerged and superseded by PR123; do not rebase or merge.

## Relevant code

- `client/src/App.tsx` — bottle-detail route, Keeper actions, theme presets/runtime, cocktail UI, and current Speakeasy/event entry points.
- `client/src/GalleryPage.tsx` — current single-file guest/Keeper gallery upload UI.
- `client/src/theme-angels.css` — Angel’s Share-only visual layer scheduled for removal in PR127.
- `client/src/BreweryLab.tsx` / `client/src/BreweryLabDetail.tsx` — guest-facing brew cards and Keeper presentation editor.
- `client/src/BottlePublicContent.tsx` — shared bottle facts and guest-facing content.
- `src/brewfather.ts` — one-way Brewfather sync; must not overwrite Keeper presentation fields/images.
- `src/speakeasy.ts` — event CRUD plus guest-safe published-event detail access.
- `src/speakeasy-shared.ts` — event/gallery types and shared constraints.
- `src/gallery.ts` — gallery upload validation/persistence via `saveGalleryUpload`.
- `src/guest-inventory-response.ts` — Guest inventory allowlists and forbidden keys.
- `client/src/EnrichmentPanel.tsx` — enrichment status, missing fields, provenance, conflicts, and diagnostics.
- `client/src/CommercialTapEnrichmentPanel.tsx` — Keeper “Find beer details” action for commercial taps.
- `src/commercial_tap_enrichment.ts` — commercial tap identity/image enrichment (reuses official beer discovery).
- `src/server.ts` — inventory/API routes, cocktail recipe import/image localization, gallery routes, events, and authorization boundaries.
- `src/cocktails.ts` — cocktail matching/recipe behavior; cocktail rows already support `image_url`.
- `src/official_brewery_beer_discovery.ts` — official beer discovery and identity gates.
- `src/ingestion/jobs/` — enrichment queue, outcomes, ownership, repair, and cleanup.
- `src/ingestion/jobs/field-ownership.ts` — durable machine-vs-human ownership; currently strongest for packaged-beer ABV/category.
- `src/ingestion/enrichment/metadata-fields.ts` — entity-specific metadata requirements.
- `src/cola_client.ts` and existing UPC helpers — GTIN normalization and validation.

Search before adding a helper. Reuse existing ownership, UPC alias, provenance, outcome, image localization, and upload utilities.

Prefer extracting new UI into `client/src/` files rather than growing `App.tsx` further.

## Validation

For each code PR:

```bash
npm test
npm run build
git diff --check
```

Also run the smallest focused test covering the changed behavior. Before squash-merging, require CI, Docker verification, and automated review to pass. After merging, confirm both `main` CI and container publishing succeed.

## Production smoke matrix

After changes to beer discovery, metadata, or enrichment UI, retest:

1. Dirt wolf — successful official enrichment control.
2. Yuengling Traditional Lager — `/our-beer/`, beer metadata, image, and GTIN regression case.
3. Ectogasm — safe authoritative-source miss.
4. One spirit and one wine — non-regression controls.

Use fresh records for pipeline testing. Review cleanup candidates first, then remove obsolete test records individually.

## Agent source of truth

- Prefer this file and `README.md` for product plan and ops.
- `.spec/target-state.md` describes shipped appliance boundaries.
- `.spec/CURRENT_TASK.md` is the active agent brief only when a task is assigned; otherwise it should say idle.
- `GEMINI_CONTEXT.md` is deprecated for planning; do not treat its line counts or test totals as current.

## Explicitly deferred

- No new external data source without a demonstrated product need and provenance design.
- No automatic migration or bulk deletion of historical inventory.
- No fuzzy acceptance of official product pages.
- No large enrichment-system redesign for UI polish.
- No new visual theme/branding expansion while the supported appearance is intentionally Light + Dark only.
