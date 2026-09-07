# Current task

**Status: active — PR124**

**PR124 — Brewery Lab guest-friendly details + Keeper-owned presentation fields**

## Objectives

1. Keep Brewfather one-way sync as the source of brewing telemetry.
2. Make The Smokey Vault own guest presentation fields on `brews` (`display_name`, `guest_description`, `tasting_notes`, `flavors`, `tags`, Keeper image).
3. Protect Keeper presentation content (including images) from Brewfather overwrite.
4. Update Brewery Lab UI to prioritize guest-facing information and add a focused detail/editor experience.
5. Preserve Guest API trust-boundary redaction.

## File boundaries

- `src/db.ts`, `src/brewfather.ts`, `src/catalog.ts`, `src/server.ts`, `src/guest-inventory-response.ts`
- `client/src/BreweryLab.tsx`, `client/src/BreweryLabDetail.tsx`, Homebrew Log fields in `client/src/App.tsx`
- focused tests in `src/brewery-lab-presentation.test.ts`

## Non-goals

Commercial keg enrichment, two-way Brewfather, AI tasting notes, packaged-beer/spirit/wine enrichment changes, broad theme redesign.
