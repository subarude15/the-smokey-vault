# Current task

**Status: active — PR125**

**PR125 — Commercial keg identity + imagery enrichment**

## Objective

Make commercial draft taps recognizable to guests without building a new generalized enrichment system.

For commercial kegs/taps, enrich enough data to show:
- brewery / brand
- beer name
- style
- ABV when confidently available
- a useful image/logo

Equivalent packaged-product artwork (can/bottle art) is acceptable when brewery + beer identity is a strong match. Brewery/beer logo is an acceptable fallback. Keg-specific artwork is not required.

## Boundaries

1. Reuse existing packaged-beer official discovery, identity, image, provenance, and normalization helpers where practical.
2. Do not weaken strong/exact identity requirements just because packaging format differs.
3. Do not require UPC/barcode identity for taps when brewery + beer name provide strong identity.
4. Do not add a new external data source unless current repository capabilities cannot satisfy the demonstrated need.
5. Preserve Keeper-entered tap values and images unless the existing ownership semantics explicitly allow machine repair.
6. Guest API must continue exposing only guest-safe tap fields.
7. Keep the PR intentionally narrow: useful tap cards, not a generalized tap enrichment platform.

## Likely areas

- `src/server.ts`
- `src/official_brewery_beer_discovery.ts`
- existing packaged-beer metadata/image enrichment helpers
- tap inventory/catalog helpers
- `src/guest-inventory-response.ts`
- tap UI in `client/src/`
- focused tap/keg enrichment tests

Search before adding helpers. Prefer adapting existing official-beer identity/image logic over duplicating it.

## Non-goals

- keg-specific product-page crawling
- broad enrichment ownership redesign
- changing Brewfather/homebrew behavior from PR124
- theme/branding work
- spirit/wine enrichment changes
- fuzzy image matching
