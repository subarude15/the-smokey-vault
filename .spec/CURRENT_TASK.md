# Current task

**Status: idle**

PR154 complete — Cocktail image discovery reliability:
- New pure `src/cocktail-image-identity.ts`: alias-aware identity model. Exact normalized name is strongest; a base-spirit prefix/suffix (e.g. Basil Smash ↔ Gin Basil Smash) is accepted only when the requested drink's own ingredients confirm that spirit; everything else rejects. Any meaningful modifier token (Strawberry/Raspberry/Smoked/…) or an unconfirmed/different base spirit rejects, and a candidate whose ingredients add a flavor variant absent from the target is rejected. Includes deterministic ingredient normalization (quantities/units stripped; whiskey-family → generic "whiskey"; gin ↔ London dry gin), a bounded 3-query plan (exact → base-spirit alias → ingredient-assisted, deduped), and `primaryBaseSpirit`/`baseSpiritsInIngredients` helpers.
- `src/cocktail_image.ts` uses the identity model in `pageIdentifiesCocktail`, `extractCocktailRecipeImage`, and `filterCocktailImageSearchHits`, runs the bounded query plan in `discoverCocktailImage`, and returns staged no-result reasons (`search_miss` / `identity_rejected` / `no_page_image` / `localize_failed` / `search_failed`). `client/src/cocktail-image-ui.ts` maps them to distinct, leak-free Keeper copy.
- All PR129 boundaries preserved: fill-missing ownership (never overwrite an existing `image_url`), rejected-host denylist, mandatory localization before persist (no remote hotlinks), no thumbnail/image-search scraping. The PR145 bounded boot backfill reuses the same improved discovery unchanged.
- Regression fixtures: Basil Smash accepts a Gin Basil Smash recipe (gin/basil/lemon/simple syrup) and localizes; Strawberry/Raspberry/Whiskey Basil Smash and Basil Margarita/Mojito reject; Smoked Old Fashioned still rejects while Bourbon/Rye/Whiskey Old Fashioned alias-accept.

Next planned product work: none queued — evidence-driven Brewery Lab / live-use follow-up per `ROADMAP.md`.
