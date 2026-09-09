# Current task

**Status: idle**

PR147 complete — Visual system / Smokey Barrel branding polish:
- The circular blackletter **SB monogram** (hop/scroll filigree) is the primary brand mark, rendered by `client/src/SbMark.tsx` on a warm near-black medallion (artwork keyed to transparency so white/gold reads in both themes). Used in the shell brand, phone topbar, landing hero, favicon, and PWA icons (`client/public/brand/*`).
- Tokenized typography: `--font-display` (`Manufacturing Consent` blackletter, weight 400, `font-synthesis:none`) for brand moments + major headers only (hero wordmark, page titles, section/feature/empty/modal headings); `--font-serif` (Playfair) for content titles; `--font-sans` (Outfit) for all body/nav/controls/forms/metadata; `--font-mono` (JetBrains Mono) only for identifier/code-like values (build id, gallery vote counters, bulk-import textarea).
- Palette stays token-driven in `client/src/theme.ts`: Dark unchanged (warm charcoal + copper/amber); Light warmed to bone/smoke with a deeper amber `--accent-2` for strong small-label contrast. Light + Dark only; no fake-metal, no new theme modes, no green/blue/purple brand signals.
- Visual-system consolidation only — no routing/navigation/IA changes.

Next planned product work: **PR148 — Live-use Guest/Keeper UX audit + focused cleanup**.
