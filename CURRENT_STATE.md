# Smokey Vault — Current Development State

Last updated: 2026-09-11

## Current position

Most recently completed:
- **PR159** — Homepage Brand Hero & Filigree Refinement (ready for review on its branch): stacked Smokey Barrel vector wordmark, continuous hop-vine filigree, single SB medallion, no Patron/Lounge homepage copy.

Previously completed:
- **PR158** — Inventory filter sentinel reliability. Mapped inventory `<option>` elements now set explicit `value={value}` so “All families” / “All flavors” / etc. keep the internal `"All"` sentinel instead of submitting label text.
- **PR157** — Cocktail photo framing and explicit Keeper photo selection.
- **PR156** — Bottle Library flavor data audit + facet reliability.
- **PR155** — Cocktail image discovery observability + production reliability.

Currently working on:
- **PR160 ready for review** — Interface Depth & Motion System. Shared frontend elevation/motion tokens and behaviors in `client/src/depth-motion.css` (card lift, touch press, panel/card/modal depth, hero layering + reveal, reduced-motion). Presentation only; Guest redaction and More-panel Keeper unlock unchanged.

Next planned:
- Live NAS/mobile verify French 75 photo framing after deploy. SearXNG health/backoff remains follow-up. Otherwise evidence-driven Brewery Lab / live-use follow-up.

## Recent architectural decisions

- Interface depth/motion (PR160): One shared CSS token layer (`--motion-*`, `--elevation-*`, `--lift-card`, `--press-*`) applied site-wide. Hover motion is pointer-gated; touch uses press scale; `prefers-reduced-motion` disables non-essential transforms/animations. Scroll parallax intentionally omitted. Do not add a second competing token system or a JS animation library for this.

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
