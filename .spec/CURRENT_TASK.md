# Current task

**Status: idle**

PR159 complete — Homepage Brand Hero & Filigree Refinement:
- New `client/src/SmokeyBarrelWordmark.tsx`: the visible "Smokey Barrel" name is genuine scalable vector `<path>` art traced from the supplied hand-lettered lockup — copper distressed `THE` (filled via `--accent`) over blackletter `Smokey` / `Barrel` (filled via `currentColor` → `--text`), so it reads in both Light and Dark. No SVG `<text>`, no font substitute, no embedded raster/base64. The Dashboard wraps it in an accessible level-1 heading, and the SVG carries the accessible name (`role="img"` + `aria-label="The Smokey Barrel"`).
- New `client/src/HopFiligree.tsx`: a restrained, decorative hop-vine filigree (also traced vector) that flows down the upper-right of the hero and fades before the CTAs. It is `aria-hidden`, `focusable={false}`, `pointer-events:none`, tinted via `--line` (charcoal/gunmetal on Dark, muted neutral on Light) with a copper touch, and clipped by the hero (`overflow:hidden`) so it never causes horizontal overflow. Verified at 320/360/390/430px.
- Hero refactor in `client/src/App.tsx`: removed the duplicate SB medallion (`hero-brand`) and the circular wine-glass orbit ornament (`hero-orbit`); the single `SbMark` medallion still anchors the shell brand and phone topbar. Removed the `PATRON MODE` Overview badge. Guest unlock affordance (rail footer + More sheet) now reads **Keeper Mode** / **Tap to unlock**. Copy preserved: `Pull up a stool.`, `Tonight's yours.`, and the guest lede.
- `src/overview.ts`: the guest branch of `overviewGreeting` now returns the plain time-of-day eyebrow (dropped `· PATRON LOUNGE`).
- `client/src/styles.css`: reworked `.hero` to a single copy column with the absolutely-positioned `.hero-filigree`; removed `.hero-orbit` / `.hero-brand` / `@keyframes orbit-glow`; responsive rules cover 1050 / 700 / 360 breakpoints.
- Tests: updated `src/overview.test.ts`, `src/shell-nav.test.ts`, and `src/overview-stats.test.ts` for the new copy/markup; added `src/pr159-homepage-hero.test.ts` (guest greeting has no Patron/Lounge; hero drops `hero-brand`/`hero-orbit`; header keeps `SbMark`; Dashboard uses the wordmark + filigree; wordmark stays an accessible h1; filigree is decorative + non-interactive; vector components have no `<text>`/raster; token-driven filigree color + mobile bounds). `npm test` and `npm run build` pass.
- Frontend presentation + copy only (plus the pure greeting helper and its tests); no DB/API/serializer/auth/schema/route changes and no rename of `PatronsPage`.

Next planned product work: none queued — evidence-driven Brewery Lab / live-use follow-up per `ROADMAP.md`.
