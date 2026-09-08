# Current task

**Status: active — PR125**

**PR125 — Enrich commercial taps with beer identity and imagery**

## Objectives

1. Reuse official packaged-beer discovery for commercial draft taps only.
2. Fill missing style / ABV / image under exact/strong brewery+beer identity.
3. Preserve Keeper-entered image, style, ABV, and notes (fill-missing).
4. Exclude Homebrew / Brewfather-linked taps.
5. Expose Keeper-only queue/status; Guest sees only public tap fields.

## File boundaries

- `src/commercial_tap_enrichment.ts`
- `src/ingestion/jobs/commercial-tap-enrichment.ts`
- `src/ingestion/jobs/worker.ts`, `src/ingestion/jobs/index.ts`
- `src/server.ts`
- `client/src/CommercialTapEnrichmentPanel.tsx`, `client/src/App.tsx`
- `src/commercial-tap-enrichment.test.ts`

## Non-goals

Keg purchasing/barcodes, fuzzy matching, Untappd/retailer-first enrichment, Brewery Lab redesign, spirit/wine enrichment, theme work.
