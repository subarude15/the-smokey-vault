# Current task

**Status: in progress — PR129**

## Objective

PR129 — Cocktail recipe-card imagery.

Improve cocktail image coverage so recipes can display a relevant cocktail photo when one is available from a trustworthy source. Reuse authoritative imagery from imported recipe pages; add conservative Keeper-only per-cocktail discovery for recipes without images; never overwrite an existing `image_url`.

## In scope

- Prefer Recipe JSON-LD / OG image from imported recipe source pages (fill-missing only)
- Keeper `Find photo` action + narrow authenticated endpoint for one cocktail at a time
- Exact-match identity gates for discovered pages (no fuzzy / stock fallbacks)
- Reuse existing `localizeImage` / network-safety infrastructure
- Cocktail card/detail rendering of `image_url` (compact, object-fit cover)
- Focused tests + ROADMAP / CURRENT_TASK updates

## Out of scope

- PR130 (duplicate Mixologist landing card)
- PR131 (Gallery albums)
- Bulk backfill, stock-photo APIs, AI image generation
- Replacing existing images / redesign of cocktail UI
- Weakening network safety

## Done when

- Existing `image_url` never overwritten by discovery or re-import
- Import fills missing images from source page when safe
- Keeper can find a photo for one image-less cocktail; Guest cannot
- No trustworthy result → `no_result`, no DB mutation
- `npm test`, `npm run build`, and `git diff --check` pass
