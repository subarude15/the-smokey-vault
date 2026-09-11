# Current task

PR160 — Interface Depth & Motion System is ready for review (stronger depth + homepage hero underlap). Shared elevation + motion tokens live in `client/src/depth-motion.css` (loaded after `styles.css` and `home-hero.css`). Homepage opening uses sticky back-plane hero + foreground scrim (mobile portrait is the primary review target).

Depth 0–4 surface planes; resting Depth-2 cards float with contact + ambient shadow, edge highlight, and restrained warm bounce-light; fine-pointer hover lifts ~8–9px into Depth 3; Depth-4 overlays (modal/More/lightbox); touch press scale without sticky hover; `prefers-reduced-motion` suppresses movement but keeps static elevation. Frontend presentation only — no backend/schema/API changes, Guest privacy preserved, More-panel Keeper unlock unchanged, PR159 brand hero preserved.

Most recently completed before this: **PR159** homepage brand hero & filigree refinement; **PR158** inventory filter sentinel reliability; **PR157** cocktail photo framing / Keeper photo selection.

Next after PR160 lands: live NAS/mobile verify photo framing; SearXNG health/backoff follow-up; otherwise evidence-driven live-use work.
