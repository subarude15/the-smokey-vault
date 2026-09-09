# Current task

**PR156 — Bottle Library flavor data audit + facet reliability** (complete on this branch).

## Production finding

Bottle Library Flavor facets looked empty in production (with or without Family = Whiskey). Not Guest redaction: enrichment tasting lived in `product_content` and never reached PR152’s inventory-only derivation. Flavor options were also global, so Family did not constrain them.

## Delivered

- Case B source of truth: derived `display_flavors` = Keeper `flavors` + `tasting_notes` + accepted enrichment official/house tasting text (controlled vocabulary only)
- Response-only attachment (`attachInventoryDisplayFlavors`); no writes into Keeper-owned inventory columns
- Guest allowlist updated for `display_flavors`; provenance/diagnostics stay stripped
- Family (+ optional Availability) constrains Flavor options; selected Flavor is not applied while building its own options
- Stale Flavor resets when Family/Availability makes it invalid
- Shared `src/spirit-flavors.ts` (client re-export); PR156 fixtures/search/facet/privacy tests

## Idle next

No concrete PR157 is defined on the roadmap; stay idle unless a new product brief is assigned.
