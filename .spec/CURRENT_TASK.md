# Current task

**Status: active — finish PR #97 (Angel’s Share + Guest availability carve-out)**

Objectives:

1. Rebase PR #97 onto current `main` (post-#122/#123).
2. Preserve Angel’s Share theme (`theme-angels.css`, presets, `?theme=angels`).
3. Expose Guest-safe derived `availability_pct` for spirits/taps on the server boundary; keep UPC, stock, raw fill/remaining, and exact pints Keeper-only.
4. Wire Guest UI gauges to the derived contract (theme-independent data; Angel’s Share visual emphasis).
5. Update tests/docs; leave #97 ready for review (do not merge).

When this lands, set this file back to idle and point at `ROADMAP.md` Track B.
