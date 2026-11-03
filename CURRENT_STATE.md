# Smokey Vault — Current Development State

Last updated: 2026-11-03

## Current position

Most recently ready for review:
- **Editable Homepage Message + Mobile Hero Layout** (draft [#182](https://github.com/subarude15/the-smokey-vault/pull/182)). Keeper Settings edit/preview/enable/reset for a plain-text homepage message (settings keys, no new table). Guests read via `/api/house` only. Disabled hides the statement for Guest and Keeper (no alternate greeting fallback). Hero underlap/contrast/spacing fixed so the message stays under the wordmark and clear of CTAs / bottom nav. Rebased onto `origin/main` after [#181](https://github.com/subarude15/the-smokey-vault/pull/181) merged.

Previously ready / merged:
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
- **PR160** — Interface Depth & Motion System.

Next planned:
- PR163 remaining precedence/ownership and PR164 Keeper progressive scanner UX.
- Live NAS/mobile verify French 75 photo framing after deploy. SearXNG health/backoff remains follow-up.
- Live phone/tablet verify homepage message + hero underlap after this PR deploys.

## Recent architectural decisions

- Homepage message: reuse `settings` + `PUBLIC_SETTING_KEYS` (`homepage_message`, `homepage_message_enabled`). Sanitize on write (`src/homepage-message.ts`); React text nodes for display (no HTML). Disable hides without clearing for Guest and Keeper. Time-of-day `overviewGreeting` eyebrow stays independent of the configurable message; `overviewHeroLede` remains a separate description.

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
- Live mobile browser verify homepage hero message clearance (narrow Android, iPhone, tablet) after deploy — automated CSS/source tests cover structure; real device underlap still worth a glance.
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
