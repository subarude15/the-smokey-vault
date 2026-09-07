# PR121 - Bottle-Detail Visual Refinement

## Objectives
1. Product-Image Containment: In `client/src/BottlePublicContent.tsx`, constrain hero image with `object-contain`, `max-h-[45vh]`, and a subtle neutral background (`bg-slate-900/40` or `bg-zinc-900/40`) so source art with large blank margins renders cleanly without layout shifts.
2. Fact Density & Deduplication: In `client/src/BottlePublicContent.tsx`, tighten vertical spacing (`space-y-2` instead of `space-y-4`), reduce inner card padding, and omit redundant ABV/Style tags from the facts list if already rendered in the hero summary badge.
3. Responsive Title Scaling: Ensure long product names (>30 chars) wrap gracefully using `break-words` and responsive text sizing (`text-xl sm:text-2xl`) without clipping or horizontal overflow.
4. Default-Collapsed Keeper Enrichment: In `client/src/EnrichmentPanel.tsx`, add a local `useState` toggle so that when all core enrichment is complete (`coreComplete === true`), the technical details and diagnostics panel starts collapsed by default, with a clean "Show details / Hide details" button.
5. High-Contrast Labels: Bump small diagnostic text and metadata labels from muted grays to high-contrast readable tokens (`text-slate-300` / `text-zinc-300`).

## File Boundaries
- `client/src/BottlePublicContent.tsx`
- `client/src/EnrichmentPanel.tsx`
- `ROADMAP.md`

## Ponytail Rules
- Do NOT edit `client/src/App.tsx`.
- Do NOT install any new packages.
- Keep diffs localized to existing JSX and Tailwind classes.
