# Current task

**PR155 — Cocktail image discovery observability + production reliability** (complete on this branch).

## Production finding

SearXNG Settings health can report connected while Keeper Find Photo still fails for common drinks (French 75). Connectivity ≠ end-to-end discovery.

## Failure stage (French 75)

SERP pre-filter treated descriptive titles as derivatives (`title includes name && title !== name`), discarding valid recipe pages before the page identity gate.

## Delivered

- Softened SERP pre-filter; strict page identity retained
- Signature-ingredient query planning
- Recipe page host vs image asset host rejection
- Bounded Keeper-only Find Photo diagnostics
- French 75 regression + diagnostics/safety tests
- Docs: next is PR156 (Bottle Library flavor) — not started

## Idle next

PR156 — Bottle Library flavor data audit + facet reliability
