# Smokey Vault — Current Development State

Last updated: 2026-11-27

## Current position

Most recently ready for review:
- **Keeper Physical Re-Inventory (Zero Shelf Counts + 0-in-Stock Workflow)** (`src/inventory-recount.ts`, `client/src/InventoryRecountCard.tsx`). Per-section Keeper count reset (`spirits`, `wines`, `packaged_beer`) preserves all bottle rows, UPCs, photos, tasting notes, enrichment history, reviews, votes, and lookup caches while leaving Taps & Homebrew untouched and recording no pours. Shelf Scan `0 → 1` restores spirits to `100%` fill (`stock_count = 1`); `0`-stock items render as **Out of stock** to Guests across Spirits/Wines/Packaged Beer while staying off automatic Restock; Keepers gain a **0 in stock** filter across all three shelf sections plus one-tap **+ Add bottle** on `0`-stock Spirit cards.

Previously ready / merged:
- **PR184** — Fix Homepage Hero Gradient Obscuring Text.
- **PR183** — Remove redundant homepage hero-lede.
- **PR182** — Editable Homepage Message + Mobile Hero Layout.
- **PR181** — Keeper tap reassignment (move/swap by exchanging `tap_number`, preserving row `id`; TapReassignModal portals to `document.body`).
- **PR180** — Patron visit history + daily check-in log.
- **PR179** — Barcode-first label scan pipeline (`identifyFromLabelImageBuffer`).
- **PR178** — Optional Ollama → Gemini AI fallback (`callLlm`).
- **PR177** — Per-event RSVP tracker.
- Guest contact confirmation copy; guest message email via `MESSAGE_NOTIFICATION_EMAILS`.
- **PR174** — Brewery water chemistry and mash pH guidance.
- **PR173** — Keeper-only brew sheet PDF.
- **PR172** — Smokey Barrel brew sheet preview.
- **PR171** — Brew recipe library and Brew Again.
- **PR170** — Keeper Brew Sheet Builder.
- **PR169** — AI brew recipe parser.
- **PR168** — Keeper-only brew sheet foundation.
- **PR165** — Conversational AI Mixologist phase 3.
- **PR160** — Interface Depth & Motion System (sticky hero underlap since rolled back for message clearance).

Next planned:
- PR163 remaining precedence/ownership and PR164 Keeper progressive scanner UX.
- Live NAS/mobile verify French 75 photo framing after deploy. SearXNG health/backoff remains follow-up.

## Recent architectural decisions

- Physical re-inventory (`src/inventory-recount.ts`): `POST /api/admin/inventory/zero-counts` (`confirm: "ZERO"`) zeroes `stock_count = 0, fill_level = 0` (`spirits`), `bottle_count = 0` (`wines`), and/or `count = 0` (`packaged_beer`) in one transaction with an admin audit event, never deleting rows or caches (no bulk purge). `isSpiritEmpty` and `spiritOnShelf` treat `stock_count <= 0` as empty/off-shelf; `saveScanSessionBottle` sets `fill_level = 100` when incrementing a spirit `0 → 1` (with full snapshot Undo). Guest responses expose coarse `out_of_stock` on `wines` as well as `spirits`/`packaged_beer`; automatic Restock skips `0`-stock items (`isZeroStockShelfItem`) while keeping empty open spirit bottles (`stock_count = 1, fill_level = 0`) and Wanted items.

- Homepage hero→content: normal document flow. No sticky pin, no runway hold, no upward content scrim. Intentional seam is `.home-content` padding + hairline border on the content plane only. `--hero-pad-bottom` is breathing room, not an underlap reserve.

- Homepage message: reuse `settings` + `PUBLIC_SETTING_KEYS` (`homepage_message`, `homepage_message_enabled`). Sanitize on write (`src/homepage-message.ts`); React text nodes for display (no HTML). Disable hides without clearing for Guest and Keeper. Time-of-day `overviewGreeting` eyebrow stays independent of the configurable message; static hero-lede removed in #183 (`overviewHeroCopy` remains empty-house fallback only).

- Tap reassignment swaps `tap_number` between existing tap rows inside a SQLite transaction (temp negative number avoids UNIQUE collisions). Beer content, enrichment jobs, reviews, and votes stay on the same `taps.id`. Empty destination = move; occupied = swap (with Keeper confirm). No schema migration.

- Patron check-ins: `patron_visits` stores dated rows (`id`, `patron_id`, `checked_in_at` UTC ISO). `visit_count` remains the leaderboard source of truth and must stay ≥ recorded dated rows (`updatePatron` enforces this). Legacy surplus = `visit_count - COUNT(visits)`. Vault-day rollover (4 AM) and Keeper time labels use `America/New_York`, not host/browser TZ (DST can make a vault day 23h or 25h). Same vault-day repeats need Keeper confirmation (`force` / `confirm_duplicate`). Void removes a specific visit row and decrements count; Minus only reduces legacy surplus. Invalid `?date=` on the Visit Log is HTTP 400.

- Label scan: `src/scan_label_pipeline.ts` is the composition root for image label routes. Exact catalog hits bypass all AI. Production should set `OLLAMA_VISION_MODEL=qwen2.5vl:7b`.

- AI client: `src/ai_client.ts` owns `callLlm` / `requestAi`. `AI_FALLBACK_PROVIDER` is opt-in.

- Per-event RSVPs: `event_rsvps` is the master guest list for one event. `event_subscribers` stays the future-events invite list.

- Brew sheets (PR168–PR174): `brew_recipes` / `brew_sessions` separate from homebrew `brews` log.

- Guest inventory/enrichment responses stay server-allowlisted; coarse availability only.
- App routing remains state-based in `App.tsx`.

## Known issues / follow-ups

- Evidence-only beer discovery: open a focused PR only when production shows a reproducible gap.
- Live NAS/mobile verify cocktail photo framing after deploy.
- Live mobile browser glance after underlap-fix deploy (automation covers computed styles + screenshots; real device still worth a look).
- SearXNG health/backoff follow-up.
- PR163 remaining: Keeper-review conflict rules beyond decoded-UPC precedence.
- PR164: progressive Keeper scanner UX (Read front label on miss).

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
