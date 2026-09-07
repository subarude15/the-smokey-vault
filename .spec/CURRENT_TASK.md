# PR122 — Harden Guest API data boundaries

## Status
Active

## Objectives
1. Add an explicit Guest-safe serializer for `GET /api/inventory/:table` so unauthenticated callers receive only patron-facing inventory fields.
2. Redact the public enrichment read model so Guest Mode never receives Keeper-only inventory rows, UPC identity, diagnostics, conflict plumbing, or job internals.
3. Keep Keeper-authenticated inventory and enrichment responses functionally unchanged (full shelf rows + diagnostics when authorized).
4. Derive a coarse Guest availability signal (`out_of_stock`) for spirits and packaged beer without exposing exact stock/fill/count values.
5. Add focused regression tests proving forbidden keys are absent from Guest JSON while Keeper JSON retains them.
6. Update Guest client out-of-stock styling to prefer `out_of_stock` when present (minimal App.tsx change).

## File boundaries
- `src/guest-inventory-response.ts` (new serializer / allowlists)
- `src/guest-inventory-response.test.ts` (new)
- `src/server.ts` (wire Guest vs Keeper serialization)
- `src/ingestion/jobs/enrichment-view.ts` (Guest enrichment projection helper, if needed)
- `src/catalog.ts` (`isSpiritEmpty` / availability helpers if needed)
- `client/src/App.tsx` (minimal: consume `out_of_stock`)
- `.spec/CURRENT_TASK.md`
- `ROADMAP.md` only if sequencing guidance must change

## Ponytail rules
- Do not redesign enrichment discovery, provenance, or ownership.
- Do not expose exact stock quantities to guests.
- Do not reduce Keeper data or mutation permissions.
- Prefer allowlist serializers over ad-hoc field deletes.
- Avoid growing `App.tsx` beyond the availability consumer fix.
