# Current task

PR160 — Interface Depth & Motion System is ready for review. Shared elevation + motion tokens live in `client/src/depth-motion.css` (loaded after `styles.css` and `home-hero.css`). Cards, panels, nav/controls, and the homepage hero use the system; hover is fine-pointer-only; touch gets press scale; `prefers-reduced-motion` is honored. Frontend presentation only — no backend/schema/API changes, Guest privacy preserved, More-panel Keeper unlock unchanged.

Most recently completed before this: **PR159** homepage brand hero & filigree refinement; **PR158** inventory filter sentinel reliability; **PR157** cocktail photo framing / Keeper photo selection.

Next after PR160 lands: live NAS/mobile verify photo framing; SearXNG health/backoff follow-up; otherwise evidence-driven live-use work.
