# GEMINI_CONTEXT.md — Deprecated

**Do not use this file as current project state.**

Line counts, test totals, API inventories, and “current work” claims that used to live here went stale and caused agent regressions.

## Source of truth

1. [`AGENTS.md`](AGENTS.md) — durable coding-agent rules
2. [`CURRENT_STATE.md`](CURRENT_STATE.md) — short rolling handoff (not a changelog)
3. [`ROADMAP.md`](ROADMAP.md) — product plan, non-negotiables, next tracks, deferred work
4. [`README.md`](README.md) — runbook, Docker/NAS ops, env integrations
5. [`.spec/target-state.md`](.spec/target-state.md) — shipped appliance boundaries
6. [`.spec/CURRENT_TASK.md`](.spec/CURRENT_TASK.md) — active agent brief only when a task is assigned
7. [`.env.example`](.env.example) — integration surface

## Still-valid conventions (short)

- Private LAN home-bar appliance; Guest Mode vs Keeper Mode (PIN + bearer)
- Node ≥ 24, Fastify + better-sqlite3, React + Vite PWA, Zod validation
- State-based navigation in `App.tsx` — do not introduce React Router for app routing
- Prefer new feature files under `client/src/` over growing `App.tsx`
- No secrets in SQLite; API keys only in environment variables
- Guest copy stays speakeasy/warm, never corporate
- Match existing conventions; small surgical diffs

For anything else (routes, schema, settings keys), read the code or OpenAPI at `/api/docs` — do not invent from memory of this file.
