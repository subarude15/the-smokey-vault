# Smokey Vault — Current Development State

Last updated: 2026-10-06

## Current position

Most recently ready for review:
- Optional AI provider fallback (Ollama/Gemma 4 primary → Gemini). Shared `callLlm` lives in `src/ai_client.ts`; `AI_FALLBACK_PROVIDER=gemini` retries once after primary failure (timeout/unreachable/5xx/empty/unusable structured output via caller `validate`). Blank = primary only (no implicit multi-key chain). Multimodal Ollama still sends `images[]`. Guest `/api/house` stays `aiConfigured` only. No commit yet unless requested.

Previously ready, not yet the latest slice:
- Per-event RSVP tracker. Dedicated `event_rsvps` table (not `event_subscribers`). Guests RSVP Going / Maybe / Can't make it on a published upcoming event detail page. Same-day RSVP stays open through the America/New_York civil date (not the Docker/host timezone). Keeper Mode manages the full list (including Facebook/text/phone manual entries), summary counts, and CSV export. Website RSVPs email `MESSAGE_NOTIFICATION_EMAILS` when SMTP is configured; mail failure does not reject the RSVP. Invite List / Get the invite is unchanged.
- Guest contact confirmation copy. After send, `ContactModal` says the smoke signals are on their way (no Discord wording for guests). Keeper Discord alert behavior is unchanged.
- Guest message email. `POST /api/messages` still stores the guest contact form in SQLite, then emails every address in `MESSAGE_NOTIFICATION_EMAILS` over SMTP (`src/mail.ts`). A mail failure is logged and the guest still gets HTTP 201. No recipients means no send. Discord's five-minute unanswered alert is unchanged. No schema change.
- **PR174** — Brewery water chemistry and mash pH guidance. Deterministic salt grams from recipe water targets/volumes (RO starting ions = 0; under-specified profiles rejected; chalk not auto-selected). Mash-pH keeps recipe/default target + measured write-in; 88% lactic dose is deferred until an established model is chosen (no homemade MCU mL). Feeds the existing `BrewSheetDocument` preview/PDF path; AI parser still does not invent salt weights. No DB migration.
- **PR173** — Keeper-only brew sheet PDF. Download PDF prints the PR172 `BrewSheetDocument` with system Chromium (`playwright-core`, `CHROMIUM_PATH`, default `/usr/bin/chromium`). No PDF is stored.
- **PR172** — Smokey Barrel brew sheet preview. The same document and CSS feed the PDF print page.
- **PR171** — Brew recipe library and Brew Again. Saved recipes, open/edit, and numbered `brew_sessions` without copying the recipe.

Previously merged:
- **PR170** — Keeper Brew Sheet Builder. Paste, analyze, review, and explicit save. Keeper Operations only.
- **PR169** — AI brew recipe parser. `POST /api/admin/brewery/parse-recipe` returns a validated `BrewRecipeDocument` and does not save.
- **PR168** — Keeper-only brew sheet foundation: `brew_recipes`, `brew_sessions`, and the structured recipe document, separate from the homebrew `brews` log.
- **PR165** — Conversational AI Mixologist phase 3 (refine the cocktail on screen). Persistent chat history is still not built.
- **PR160** — Interface Depth & Motion System. Shared frontend Depth 0–4 elevation/motion in `client/src/depth-motion.css`.

Previously completed:
- **PR158** — Inventory filter sentinel reliability. Mapped inventory `<option>` elements now set explicit `value={value}` so “All families” / “All flavors” / etc. keep the internal `"All"` sentinel instead of submitting label text.
- **PR157** — Cocktail photo framing and explicit Keeper photo selection.
- **PR156** — Bottle Library flavor data audit + facet reliability.
- **PR155** — Cocktail image discovery observability + production reliability.

Next planned, after this phase is reviewed:
- Live NAS/mobile verify French 75 photo framing after deploy. SearXNG health/backoff remains follow-up.

## Recent architectural decisions

- AI client: `src/ai_client.ts` owns `callLlm` / `requestAi`. `AI_FALLBACK_PROVIDER` is opt-in (`[primary, fallback]`); blank = primary only. Callers may pass `validate` so structurally unusable JSON triggers retryable fallback without embedding schemas in the client. Empty/whitespace model text is retryable. Ollama multimodal uses chat `messages[].images`. System prompts use Ollama `role=system` when supplied. Default Ollama chat model is `gemma4` (`OLLAMA_VISION_MODEL` remains separate for enrichment verification).

- Per-event RSVPs: `event_rsvps` is the master guest list for one event. `event_subscribers` stays the future-events invite list. Guest POST is website-only and never lists others. Keepers enter Facebook/text/phone by hand (no Groups API). Expected guests = sum of Going `party_size`. Event delete cascades RSVP rows.

- Guest message email: the contact form and `messages` table are unchanged. Notification sits behind `acceptGuestMessage` and an SMTP transport in `src/mail.ts`. Recipients and credentials are environment-only. Page context is the Referer only when its host is this vault. `VAULT_PUBLIC_URL` wins over the request host for the link back. Website RSVP notices reuse the same SMTP helper (`deliverOwnerMail`).

- Brew sheets (PR168–PR174): `brew_recipes` and `brew_sessions` stay separate from the homebrew `brews` log. Parsing and saving are separate actions. Brew Again inserts a numbered session on the existing recipe. Preview and PDF both render `BrewSheetDocument`. Water mineral salt grams come only from `src/brew_water_chemistry.ts` (never from the AI parser); mash-pH target guidance is shown without inventing a lactic mL dose until a documented model is wired. Treatment volume requires strike+sparge or explicit totalWater — lone strike/sparge does not invent total. `GET /api/admin/brewery/recipes/:id/pdf` is keeper-only and generates the file in memory. Chromium reads a loopback-only short-lived render token, not a public recipe URL. Dirty unsaved edits do not offer Download PDF. The print page loads static Outfit files because Chromium’s variable-font PDF export collapses to Thin. The Docker image also installs Liberation Sans for when that fetch fails. The app stays up if Chromium is missing. The builder is a Keeper Operations page (`brew_sheets`), not a replacement for Brewery Lab. Guest navigation does not list it.

- Interface depth/motion (PR160): One shared CSS token layer (`--motion-*`, `--surface-*`, `--elevation-1..4`, `--edge-*`, `--lift-card`, `--press-*`) applied site-wide. Resting Depth-2 must be obvious without hover. Hover motion is fine-pointer-gated (~8–9px); touch uses press scale with sticky-hover cancelled; reduced-motion disables movement but must not flatten static elevation. Homepage underlap is CSS sticky + scrim only (no scroll listeners / parallax). Do not add a second competing token system or a JS animation library for this.

- Inventory filter options (PR158): Display labels (“All families”, “All flavors”, …) must never become submitted values. Mapped `<option>` elements use `value={value}` with `"All"` as the sole clear/reset sentinel.

- Cocktail photo choice (PR157): native dialog for full-photo viewing and Keeper editing; shared ImageField for uploads.

- Bottle Library flavors (PR156): Facet/search source of truth is derived presentation `display_flavors`, not a DB mutation.

- Branding is a single tokenized visual system (PR147): the SB monogram medallion (`SbMark`) is the one brand mark; Light + Dark only; warm whiskey-cellar palette. Do not reintroduce removed theme modes or fake-metal treatments.

- Guest inventory/enrichment responses stay server-allowlisted; coarse availability only.
- App routing remains state-based in `App.tsx` (no React Router for primary navigation).

## Known issues / follow-ups

- Evidence-only beer discovery: open a focused PR only when production shows a reproducible gap.
- Live NAS/mobile verify cocktail photo framing after deploy.
- SearXNG health/backoff follow-up.

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
