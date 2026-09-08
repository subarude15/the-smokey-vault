# AGENTS.md

Durable instructions for coding agents working on **The Smokey Vault** (private home-bar appliance; Smokey Barrel branding is planned polish, not a separate app).

## Project

The Smokey Vault is a LAN-hosted web app for a basement home bar. Guests should quickly understand:

- what beer, spirits, cocktails, and homebrew are available
- what cocktails can currently be made
- upcoming events
- brewery/homebrew information in approachable language

**Guest Mode** is the read-oriented speakeasy portal. **Keeper Mode** (PIN + bearer) is for inventory, enrichment, media, and other admin edits.

## Source of truth

| File | Role |
|------|------|
| `AGENTS.md` | Durable agent rules (this file) |
| `CURRENT_STATE.md` | Short rolling handoff — read at the start of every coding chat |
| `ROADMAP.md` | Product plan, non-negotiables, next PRs |
| `README.md` | Runbook / Docker / ops |
| `.spec/target-state.md` | Shipped appliance boundaries |
| `.spec/CURRENT_TASK.md` | Active brief only when a task is assigned; otherwise idle |

Prefer these over chat history. `GEMINI_CONTEXT.md` is deprecated for planning.

## Development philosophy

- Inspect existing architecture before coding; extend established patterns instead of inventing parallel systems.
- Prefer small, maintainable changes over clever abstractions.
- Preserve mobile/tablet usability; treat tablet Keeper workflows as first-class.
- Preserve Guest / Keeper separation.
- Avoid unrelated refactors inside feature PRs.
- Maintain backwards compatibility wherever practical.
- Add or update focused automated tests for changed behavior.
- Run relevant tests (and build where applicable) before declaring a PR complete.

## Guest privacy

Guest Mode must never expose Keeper-only operational or internal data.

Before changing any guest-facing API or UI:

- Inspect guest serializers / allowlists (for example `src/guest-inventory-response.ts`).
- Do not leak inventory internals (exact stock, UPCs, enrichment diagnostics, etc.).
- Keeper-only controls must not become guest-visible.

## Images / media

Reuse shared media infrastructure (`client/src/ImageField.tsx`, `src/images.ts`, gallery/media routes).

- Do not invent feature-specific upload stacks when the shared path fits.
- Preserve phone camera, file upload, paste, drag/drop, and URL workflows where they already exist.
- Never overwrite Keeper-owned imagery automatically.
- Keep feature-specific image behavior isolated when appropriate (for example commercial-tap enrichment must not invent a second upload system).

## Roadmap workflow

`ROADMAP.md` is the authoritative development roadmap.

1. Read it before starting a numbered roadmap PR.
2. Confirm the request still matches the current repository state.
3. Update `ROADMAP.md` when implementation status materially changes.
4. Never mark a PR complete before implementation and verification are done.
5. Do not reorder unrelated roadmap entries without instruction.

## Current-state workflow

`CURRENT_STATE.md` is a **short** rolling handoff. Update it at the end of meaningful PR work.

It must not become a historical changelog. Keep detailed history in git / PR descriptions.

## Before coding a roadmap PR

1. Read `AGENTS.md`.
2. Read `CURRENT_STATE.md`.
3. Read the relevant `ROADMAP.md` entry.
4. Inspect the current implementation for that feature.
5. Check existing tests.
6. Adapt the roadmap requirement to current architecture — do not blindly implement stale wording.

## Completion checklist

Before declaring work ready for review:

- [ ] Implementation complete for the requested scope
- [ ] Focused tests added or updated
- [ ] Relevant existing tests run
- [ ] Build / typecheck run where applicable (`npm test`, `npm run build`)
- [ ] Responsive / tablet Keeper impact considered
- [ ] Guest vs Keeper behavior verified
- [ ] `ROADMAP.md` updated if status changed
- [ ] `CURRENT_STATE.md` updated

Final summary should include: what changed, files touched, tests/results, notable architectural decisions, and remaining concerns.
