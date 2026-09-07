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
- Post-#119 main work (not separate GitHub PR numbers):
  - **main/120** — Keeper enrichment clarity (status UI).
  - **main/121** — Bottle-detail visual refinement, plus a follow-up Hooks ordering fix for EnrichmentPanel.
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
- main/120 — Keeper enrichment clarity.
- main/121 — Bottle-detail visual refinement and EnrichmentPanel Hooks fix.

GitHub pull request numbers stop at **#119** for that line. Later items labeled main/120 and main/121 landed as direct commits on `main`.

## Next work

Stability-first. Prefer small, testable PRs that reduce bugs and tighten Guest/Keeper boundaries. Do not open speculative discovery features.

### Track A — Evidence-only discovery

Do not pre-plan official-beer discovery work. Open a focused PR only when a fresh production case proves a reproducible gap. Ectogasm alone is not a bug while Drekker publishes no authoritative product page.

### Track B — Hardening (planned)

Priority order:

1. **Server-side guest inventory / enrichment redaction** — Guest UI already hides UPC and stock chips (PR #93), but `GET /api/inventory/:table` and the public enrichment view still return full shelf rows to non-admin callers. Strip keeper metadata (UPC, stock/bottle counts, shelf location, enrichment diagnostics/conflict plumbing) for guests; keep guest-useful facts (name, brand, style, ABV, notes, image, votes).
2. **Triage draft PR #53** (enrichment review actions) — Do not merge as-is. It is far behind `main`, conflicts with the current ownership/queue stack, and can fight packaged-beer field allowlists. Close it, or redesign onto `product_field_ownership` + beer allowlists + delete cleanup.
3. **Decide PR #97** (Angel’s Share theme) — Architecturally additive. Product call: treat guest-visible fill/keg gauges as an intentional availability carve-out while UPC/stock stay keeper-only; then rebase and merge, or park the PR.
4. **Scope Watchtower** on the NAS compose (labels / `WATCHTOWER_LABEL_ENABLE`) so it cannot recreate unrelated containers.
5. **Client 401 → clear Keeper session** when the bearer expires, instead of waiting for idle lock alone.
6. **Ownership expansion only when a real overwrite bug appears** — Durable ownership today is strongest for packaged-beer ABV/category. Do not start a large enrichment redesign for polish.

## Open PR status

- **#97** Angel’s Share theme — open; rebase + availability carve-out decision required (Track B #3).
- **#53** Enrichment review actions — draft; do not merge as-is (Track B #2).
- **#78** Agentage memory MCP — draft tooling only; not product roadmap.

## Relevant code

- `client/src/App.tsx` — bottle-detail route and Keeper actions.
- `client/src/BottlePublicContent.tsx` — shared bottle facts and guest-facing content.
- `client/src/EnrichmentPanel.tsx` — enrichment status, missing fields, provenance, conflicts, and diagnostics.
- `src/server.ts` — inventory API routes and authorization boundaries.
- `src/official_brewery_beer_discovery.ts` — official beer discovery and identity gates.
- `src/ingestion/jobs/` — enrichment queue, outcomes, ownership, repair, and cleanup.
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
