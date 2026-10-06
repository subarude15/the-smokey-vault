# Smokey Vault — Current Development State

Last updated: 2026-10-06

## Current position

Most recently ready for review (uncommitted — do not push until requested):
- **Barcode-first label scan pipeline.** Shared `identifyFromLabelImageBuffer` for `/api/scan/label`, `/api/ai/vision-label`, and import-queue label. Flow: ZXing decode on the uploaded image → existing `identifyByBarcode` exact lookup (vault → caches → FWGS/COLA/OFF/upcitemdb) → only on miss, dedicated `OLLAMA_VISION_MODEL` vision (deploy `qwen2.5vl:7b`; default `llama3.2-vision`) → `callLlm` Gemma/Gemini fallback on vision failure. Exact hits set `identification_method: "barcode_exact"` and never call AI. `[SCAN]` timing logs; decoded GTIN outranks AI `upc`. No EmbeddingGemma / vector work.

Previously ready:
- Optional AI provider fallback (Ollama/Gemma 4 primary → Gemini). Shared `callLlm` in `src/ai_client.ts`; `AI_FALLBACK_PROVIDER=gemini` retries once after primary failure. Guest `/api/house` stays `aiConfigured` only.
- Per-event RSVP tracker. Dedicated `event_rsvps` table. Guests RSVP Going / Maybe / Can't make it. Keeper manages list + CSV. Website RSVPs email when SMTP configured.
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

Next planned, after this phase is reviewed:
- Commit/PR for barcode-first scan when approved; then PR163 remaining precedence/ownership and PR164 Keeper progressive scanner UX.
- Live NAS/mobile verify French 75 photo framing after deploy. SearXNG health/backoff remains follow-up.

## Recent architectural decisions

- Label scan: `src/scan_label_pipeline.ts` is the composition root for image label routes. Deterministic `@zxing/library` decode (already a dependency; pure JS + sharp greyscale) runs before any LLM. Exact catalog hits bypass all AI. Vision uses `ollamaVisionModel()` / `ollamaChatUrl()`, not `AI_MODEL`. `llama3.2-vision` remains the unset default; production should set `OLLAMA_VISION_MODEL=qwen2.5vl:7b`.

- AI client: `src/ai_client.ts` owns `callLlm` / `requestAi`. `AI_FALLBACK_PROVIDER` is opt-in. Callers may pass `validate` for structured-output fallback. Default Ollama chat model is `gemma4`.

- Per-event RSVPs: `event_rsvps` is the master guest list for one event. `event_subscribers` stays the future-events invite list.

- Brew sheets (PR168–PR174): `brew_recipes` / `brew_sessions` separate from homebrew `brews` log. Water salt grams from `src/brew_water_chemistry.ts` only.

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
