# Smokey Vault — Current Development State

Last updated: 2026-09-08

## Current position

Most recently completed:
- **PR139** — Repository AI agent context / durable handoff setup (merged). Added `AGENTS.md` and `CURRENT_STATE.md`; aligned roadmap numbering so GitHub PR numbers stay authoritative (former product PR139+ shifted forward by one).

Currently working on:
- None.

Next planned:
- **PR140 — Event image crop / resize controls** (`ROADMAP.md` Track C).

## Recent architectural decisions

- Guest inventory/enrichment responses stay server-allowlisted (`guest-inventory-response`); coarse availability only.
- Shared `ImageField` / `images` media path is the default for Keeper uploads; do not add parallel upload systems per feature.
- Absolute `/api/media/images/...` URLs collapse to relative paths only when the origin matches the app/request; foreign CDNs with that path stay remote.
- Upload failure must not call `onChange` with a captured prior value (avoids racing a newer successful image).
- Commercial tap enrichment reuses exact vault packaged-beer images; homebrew taps stay excluded; Keeper-owned images are not auto-overwritten.
- Appearance support is Light + Dark only (PR127).
- App routing remains state-based in `App.tsx` (no React Router for primary navigation).
- GitHub PR numbers are authoritative for roadmap numbering; when a docs/tooling PR consumes a number, later planned product PRs shift forward (PR139 docs → next product work is PR140).

## Known issues / follow-ups

- Evidence-only beer discovery: open a focused PR only when production shows a reproducible gap (see Track A).
- Draft **#121** branding docs remain deferred until PR145.
- Ops hardening (Watchtower scope, ownership expansion) stays evidence-driven and must not displace the next product PR.

## Handoff

Future coding agents should read, in order:

1. `AGENTS.md`
2. `CURRENT_STATE.md` (this file)
3. The relevant `ROADMAP.md` entry
4. Current implementation and tests for the feature

Then implement against the **current** architecture, not outdated roadmap wording.
