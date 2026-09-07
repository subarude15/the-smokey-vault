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
- PR97 — Angel’s Share theme and guest availability carve-out merged. Theme/branding refinement is intentionally deferred until the broader site brand direction is settled.

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

1. **Brewery Lab: make Brewfather-backed batches understandable and editable in The Smokey Vault.** *(PR124 in progress)*
   - Keep Brewfather as the source for brewing-specific batch data, but do not expose its raw/API-shaped model as the primary experience.
   - Add a human-readable presentation layer for people who are not homebrewers: plain-language beer name/style, status, ABV, brew/package dates where useful, concise batch story/description, and clearly labeled brewing details behind an optional deeper view.
   - Allow Keeper edits for site-owned presentation fields without corrupting Brewfather source data. At minimum support custom display name/description, tasting notes, and photos; consider serving notes or “what to expect” copy where it improves the guest experience.
   - Define field ownership explicitly so Brewfather sync refreshes machine-owned brewing data while preserving Keeper-written notes, photos, and presentation copy.
   - Guest Mode should read like a brewery taproom card, not a brewing-software API response.

2. **Draft keg enrichment: show recognizable beer identity and imagery for commercial kegs.**
   - For commercial draft beer, enrich enough metadata to make the tap/keg recognizable: brewery/brand, beer name, style, ABV when confidently available, and at least one useful image/logo.
   - Prefer an official product/brand image when available, but a verified image of the equivalent packaged product (can/bottle artwork) is acceptable because most draft beers are also sold packaged.
   - A brewery/beer logo is an acceptable fallback when product packaging art is unavailable.
   - Do not require keg-specific artwork or keg-only product pages to succeed.
   - Preserve strict identity matching: packaging format may differ, but brewery + beer identity must match strongly before reusing canned/bottled imagery or metadata.
   - Keep this intentionally lightweight; the goal is a useful guest-facing tap card, not a new generalized enrichment architecture.

## Open PR status

- **#121** Google Stitch `DESIGN.md` — draft branding/theme documentation; intentionally deferred until site branding direction is clearer.
- **#78** Agentage memory MCP — draft tooling only; not product roadmap.
- **#53** Enrichment review actions — closed unmerged and superseded by PR123; do not rebase or merge.

## Relevant code

- `client/src/App.tsx` — bottle-detail route and Keeper actions.
- `client/src/BreweryLab.tsx` / `client/src/BreweryLabDetail.tsx` — guest-facing brew cards and Keeper presentation editor.
- `client/src/BottlePublicContent.tsx` — shared bottle facts and guest-facing content.
- `src/brewfather.ts` — one-way Brewfather sync; must not overwrite Keeper presentation fields/images.
- `src/guest-inventory-response.ts` — Guest inventory allowlists and forbidden keys.
- `client/src/EnrichmentPanel.tsx` — enrichment status, missing fields, provenance, conflicts, and diagnostics.
- `src/server.ts` — inventory API routes and authorization boundaries.
- `src/official_brewery_beer_discovery.ts` — official beer discovery and identity gates.
- `src/ingestion/jobs/` — enrichment queue, outcomes, ownership, repair, and cleanup.
- `src/ingestion/jobs/field-ownership.ts` — durable machine-vs-human ownership; currently strongest for packaged-beer ABV/category.
- `src/ingestion/enrichment/metadata-fields.ts` — entity-specific metadata requirements.
- `src/cola_client.ts` and existing UPC helpers — GTIN normalization and validation.

Search before adding a helper. Reuse existing ownership, UPC alias, provenance, and outcome utilities.

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
- Branding/theme refinement beyond existing shipped themes until the broader site brand direction is settled.
