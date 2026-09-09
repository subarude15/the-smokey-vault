# Current task

**Status: idle**

PR148 complete — Live-use Guest/Keeper UX audit + focused cleanup.

Ponytail audit found no P0 regressions. Bounded implementation list:

1. Removed the duplicate Guest topbar Keeper PIN shortcut; the More/rail entry and unlock flow remain.
2. Generic Keeper card actions stay visible on touch devices that cannot hover.
3. Phone toasts clear the fixed bottom navigation.
4. Stale Guest-facing “Admin” / “Patron Mode” wording now uses Guest/Keeper terminology.

Deferred: global touch-target expansion, Brewery Lab follow-up, IA changes, media redesign, and backend/schema work without a reproducible live-use failure.
