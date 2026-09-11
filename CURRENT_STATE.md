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
- **PR160 ready for review** — Interface Depth & Motion System (strengthened). Shared frontend Depth 0–4 elevation/motion in `client/src/depth-motion.css`: visible resting card float, ~8–9px hover lift, edge lighting, warm bounce-light, Depth-4 overlays, touch press, hero layering + reveal, and CSS sticky homepage hero underlap (content + scrim pass over the hero; no parallax). Reduced-motion keeps static elevation. Presentation only; Guest redaction and More-panel Keeper unlock unchanged.

Next planned:
- Live NAS/mobile verify French 75 photo framing after deploy. SearXNG health/backoff remains follow-up. Otherwise evidence-driven Brewery Lab / live-use follow-up.

## Recent architectural decisions

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
