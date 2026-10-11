# Smokey Vault — Current Development State

Last updated: 2026-10-11

## Current position

Most recently ready for review:
- **Patron visit history + daily check-in log** (draft [#180](https://github.com/subarude15/the-smokey-vault/pull/180)). Additive `patron_visits` table; Keeper check-in timestamps, per-patron history, vault-day Visit Log (4 AM), duplicate confirmation, void-by-visit-id. Cumulative `visit_count` / guest leaderboard ranking unchanged; no fabricated dated rows for legacy counts.

Previously ready / merged:
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

## Recent architectural decisions

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
