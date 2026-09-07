# Target State Specification

Shipped appliance boundaries for The Smokey Vault. Architects and agents must keep changes inside this envelope unless `ROADMAP.md` explicitly expands it.

## Core product

- **Private LAN appliance** — Synology/Docker home-server deploy; no public SaaS multi-tenant model; no payment processing.
- **Two modes** — Guest Mode (read-oriented speakeasy portal / digital bar menu) and Keeper Mode (PIN + short-lived bearer for inventory and ops).
- **Inventory engine** — SQLite-backed spirits, wines, packaged beer, taps, and homebrew/brews with depletion-aware fields and safe per-item deletion.
- **Mixology** — Cocktail definitions, shelf matching, substitutions, optional AI mixologist.
- **Enrichment** — Provenance-safe catalog lookup and background jobs (metadata, tasting notes, images), including official brewery discovery for packaged beer under strict identity rules.
- **Guest portal extras** — Patrons, events/RSVP, tip jar, merch, staff/crew, gallery, guest messages (tabs may be disabled in settings).
- **Brewery Lab** — Tap + fermenting pipeline; optional Brewfather one-way sync.
- **UI** — Vite + React SPA with state-based navigation (not React Router), PWA install for kiosk/phones, theme presets.
- **Ops** — Docker Compose (local build + NAS pull), optional government catalog imports, optional COLA / Catalog.beer / AI / Figranium / Discord integrations via env.

## Hard boundaries

- Preserve Keeper/user-owned field values; never weaken provenance to force a match.
- Packaged beer stays out of the Bottle Library / spirits table and must not invent proof, generic `volume_ml`, origin, or TTB ID.
- Deletion is per-item, authenticated, transactional, and cleanup-aware — no bulk purge automation.
- Guest Mode must not expose keeper operational metadata (UPC, stock counts, enrichment diagnostics); Guest inventory/enrichment responses are allowlisted server-side.
- Missing authoritative data is a valid outcome.

## Non-goals

- Public internet exposure, accounts-as-a-service, or payment rails
- Automatic bulk inventory migration or fuzzy official-page acceptance
- Large enrichment redesigns for polish without a demonstrated correctness bug
