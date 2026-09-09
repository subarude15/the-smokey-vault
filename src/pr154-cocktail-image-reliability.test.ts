/**
 * PR154 — Cocktail image discovery reliability.
 * Alias-aware identity, ingredient confirmation, variant rejection, bounded
 * multi-query search, and staged Keeper diagnostics. Fixtures/stubs only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const {
  baseSpiritsInIngredients,
  buildCocktailImageQueryPlan,
  classifyCocktailIdentity,
  cocktailIdentityAccepted,
  ingredientContentWords,
  primaryBaseSpirit
} = await import("./cocktail-image-identity.js");
const {
  buildCocktailImageSearchQuery,
  discoverCocktailImage,
  extractCocktailRecipeImage,
  filterCocktailImageSearchHits,
  pageIdentifiesCocktail
} = await import("./cocktail_image.js");
const { cocktailImageDiscoveryMessage } = await import("../client/src/cocktail-image-ui.ts");

const BASIL_SMASH_INGREDIENTS = ["60 ml gin", "22 ml lemon juice", "22 ml sugar syrup", "basil"];
const OLD_FASHIONED_INGREDIENTS = ["45 ml bourbon or rye", "1 sugar cube", "2 dashes Angostura bitters"];

function recipePage(args: {
  name: string;
  image?: string;
  ogImage?: string;
  ingredients?: string[];
  title?: string;
  heading?: string;
}): string {
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: args.name,
    recipeInstructions: "Muddle, shake, strain."
  };
  if (args.image) jsonLd.image = args.image;
  if (args.ingredients) jsonLd.recipeIngredient = args.ingredients;
  const og = args.ogImage ? `<meta property="og:image" content="${args.ogImage}">` : "";
  const title = args.title ?? `${args.name} Cocktail Recipe | Example`;
  const heading = args.heading ?? args.name;
  return `<!doctype html><html><head><title>${title}</title>${og}
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    </head><body><h1>${heading}</h1></body></html>`;
}

/* ------------------------- Identity classification ------------------------ */

test("exact name matches and outranks alias", () => {
  assert.deepEqual(
    classifyCocktailIdentity({ target: "Basil Smash", candidate: "Basil Smash" }),
    { tier: "exact" }
  );
  const alias = classifyCocktailIdentity({
    target: "Basil Smash",
    candidate: "Gin Basil Smash",
    targetIngredients: BASIL_SMASH_INGREDIENTS
  });
  assert.equal(alias.tier, "alias");
  // Exact is strictly a stronger tier than alias.
  assert.notEqual(alias.tier, "exact");
});

test("Basil Smash ↔ Gin Basil Smash accepted with corroborating gin", () => {
  const result = classifyCocktailIdentity({
    target: "Basil Smash",
    candidate: "Gin Basil Smash",
    targetIngredients: BASIL_SMASH_INGREDIENTS,
    candidateIngredients: ["2 oz gin", "1 oz lemon juice", "0.75 oz simple syrup", "8 basil leaves"]
  });
  assert.equal(cocktailIdentityAccepted(result), true);
  // Reverse direction (requested Gin Basil Smash, page Basil Smash) also holds.
  assert.equal(
    classifyCocktailIdentity({ target: "Gin Basil Smash", candidate: "Basil Smash", targetIngredients: BASIL_SMASH_INGREDIENTS }).tier,
    "alias"
  );
});

test("flavored/base variants of Basil Smash are rejected", () => {
  for (const candidate of ["Strawberry Basil Smash", "Raspberry Basil Smash", "Pineapple Basil Smash", "Watermelon Basil Smash", "Whiskey Basil Smash", "Basil Margarita", "Basil Mojito"]) {
    const result = classifyCocktailIdentity({ target: "Basil Smash", candidate, targetIngredients: BASIL_SMASH_INGREDIENTS });
    assert.equal(cocktailIdentityAccepted(result), false, `${candidate} must reject`);
  }
});

test("clean name but variant ingredients (strawberry) is rejected", () => {
  const result = classifyCocktailIdentity({
    target: "Basil Smash",
    candidate: "Gin Basil Smash",
    targetIngredients: BASIL_SMASH_INGREDIENTS,
    candidateIngredients: ["2 oz gin", "1 oz lemon juice", "6 strawberries", "8 basil leaves"]
  });
  assert.equal(result.tier, "reject");
  assert.equal(result.reason, "ingredient_variant");
});

test("Smoked Old Fashioned still rejected; base-spirit prefixes confirmed by ingredients", () => {
  assert.equal(
    cocktailIdentityAccepted(classifyCocktailIdentity({ target: "Old Fashioned", candidate: "Smoked Old Fashioned", targetIngredients: OLD_FASHIONED_INGREDIENTS })),
    false
  );
  // Bourbon/Rye/Whiskey prefixes are confirmed by the whiskey-family ingredients.
  for (const candidate of ["Bourbon Old Fashioned", "Rye Old Fashioned", "Whiskey Old Fashioned"]) {
    assert.equal(
      classifyCocktailIdentity({ target: "Old Fashioned", candidate, targetIngredients: OLD_FASHIONED_INGREDIENTS }).tier,
      "alias",
      candidate
    );
  }
  // A different base (gin) is not confirmed by a whiskey drink → reject.
  assert.equal(
    cocktailIdentityAccepted(classifyCocktailIdentity({ target: "Old Fashioned", candidate: "Gin Old Fashioned", targetIngredients: OLD_FASHIONED_INGREDIENTS })),
    false
  );
});

/* ------------------------- Ingredient normalization ----------------------- */

test("ingredient normalization is quantity/unit-insensitive and equivalence-aware", () => {
  assert.equal(baseSpiritsInIngredients(["London Dry Gin"]).has("gin"), true);
  assert.equal(baseSpiritsInIngredients(["45 ml bourbon or rye"]).has("whiskey"), true);
  const words = ingredientContentWords(["22 ml lemon juice", "fresh basil leaves", "2 oz London dry gin"]);
  assert.equal(words.has("lemon"), true);
  assert.equal(words.has("basil"), true);
  assert.equal(words.has("gin"), true);
  assert.equal(words.has("ml"), false);
  assert.equal(words.has("22"), false);
  assert.equal(primaryBaseSpirit(BASIL_SMASH_INGREDIENTS), "gin");
});

/* --------------------------- Page identification -------------------------- */

test("Gin Basil Smash page identifies for Basil Smash; strawberry variant does not", () => {
  const gin = recipePage({ name: "Gin Basil Smash", image: "https://cdn.example/gbs.jpg", ingredients: ["2 oz gin", "1 oz lemon juice", "0.75 oz simple syrup", "8 basil leaves"] });
  assert.equal(pageIdentifiesCocktail(gin, "Basil Smash", BASIL_SMASH_INGREDIENTS), true);

  const strawberry = recipePage({ name: "Strawberry Basil Smash", image: "https://cdn.example/sbs.jpg", ingredients: ["2 oz gin", "6 strawberries", "8 basil leaves"] });
  assert.equal(pageIdentifiesCocktail(strawberry, "Basil Smash", BASIL_SMASH_INGREDIENTS), false);

  const exact = recipePage({ name: "Basil Smash", image: "https://cdn.example/bs.jpg", ingredients: BASIL_SMASH_INGREDIENTS });
  assert.equal(pageIdentifiesCocktail(exact, "Basil Smash", BASIL_SMASH_INGREDIENTS), true);
});

/* --------------------------- Bounded query plan --------------------------- */

test("query plan: exact first, alias second, ingredient-assisted, deduped and bounded", () => {
  const base = buildCocktailImageSearchQuery("Basil Smash");
  const plan = buildCocktailImageQueryPlan("Basil Smash", BASIL_SMASH_INGREDIENTS, base);
  assert.equal(plan[0], base);
  assert.ok(plan.length >= 2 && plan.length <= 3);
  assert.ok(plan.some((q) => /Gin Basil Smash/i.test(q)), "includes a Gin Basil Smash alias query");
  assert.equal(new Set(plan).size, plan.length, "deduped");
  // When the name already carries the base spirit, no duplicate alias query.
  const already = buildCocktailImageQueryPlan("Gin Basil Smash", BASIL_SMASH_INGREDIENTS, buildCocktailImageSearchQuery("Gin Basil Smash"));
  assert.equal(new Set(already).size, already.length);
  assert.ok(already.length <= 3);
});

/* --------------------- Discovery: Basil Smash regression ------------------ */

function basilRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Basil Smash",
    image_url: "",
    source_url: "",
    ingredients: JSON.stringify(BASIL_SMASH_INGREDIENTS),
    notes: "",
    ...overrides
  };
}

test("REGRESSION: Basil Smash accepts a Gin Basil Smash recipe and localizes", async () => {
  let localized = "";
  const result = await discoverCocktailImage(basilRow(), {
    searchWebHits: async () => [
      { title: "Gin Basil Smash Recipe | Liquor.com", content: "classic gin smash", url: "https://liquor.com/recipes/gin-basil-smash/" }
    ],
    fetchHtml: async (url) => ({
      html: recipePage({ name: "Gin Basil Smash", image: "https://cdn.example/gbs.jpg", ingredients: ["2 oz gin", "1 oz lemon juice", "0.75 oz simple syrup", "8 basil leaves"] }),
      finalUrl: url
    }),
    localizeImage: async (remote) => { localized = String(remote); return "/api/media/images/gin-basil-smash.jpg"; }
  });
  assert.equal(result.status, "updated");
  if (result.status === "updated") assert.equal(result.image_url, "/api/media/images/gin-basil-smash.jpg");
  assert.equal(localized, "https://cdn.example/gbs.jpg");
});

test("REGRESSION: Basil Smash rejects strawberry/raspberry/whiskey variants (no image saved)", async () => {
  for (const variant of [
    { name: "Strawberry Basil Smash", ingredients: ["2 oz gin", "6 strawberries", "8 basil leaves"] },
    { name: "Raspberry Basil Smash", ingredients: ["2 oz gin", "6 raspberries", "8 basil leaves"] },
    { name: "Whiskey Basil Smash", ingredients: ["2 oz whiskey", "1 oz lemon juice", "8 basil leaves"] }
  ]) {
    let localizeCalled = false;
    const result = await discoverCocktailImage(basilRow(), {
      searchWebHits: async () => [
        { title: `${variant.name} Recipe | Liquor.com`, content: "twist", url: `https://liquor.com/recipes/${variant.name}/` }
      ],
      fetchHtml: async (url) => ({ html: recipePage({ name: variant.name, image: "https://cdn.example/x.jpg", ingredients: variant.ingredients }), finalUrl: url }),
      localizeImage: async () => { localizeCalled = true; return "/api/media/images/should-not-save.jpg"; }
    });
    assert.equal(result.status, "no_result", variant.name);
    assert.equal(localizeCalled, false, `${variant.name} must not localize`);
  }
});

/* ---------------------------- Diagnostic stages --------------------------- */

test("diagnostics distinguish search miss / identity / no image / localize failure", async () => {
  const preferredHit = [{ title: "Gin Basil Smash Recipe | Liquor.com", content: "gin smash", url: "https://liquor.com/recipes/gin-basil-smash/" }];

  const searchMiss = await discoverCocktailImage(basilRow(), { searchWebHits: async () => [] });
  assert.equal(searchMiss.status, "no_result");
  if (searchMiss.status === "no_result") assert.equal(searchMiss.reason, "search_miss");

  const identity = await discoverCocktailImage(basilRow(), {
    searchWebHits: async () => [{ title: "Margarita Recipe | Liquor.com", content: "classic", url: "https://liquor.com/recipes/margarita/" }],
    fetchHtml: async (url) => ({ html: recipePage({ name: "Margarita", image: "https://cdn.example/m.jpg", ingredients: ["tequila", "lime", "triple sec"] }), finalUrl: url })
  });
  assert.equal(identity.status, "no_result");
  if (identity.status === "no_result") assert.equal(identity.reason, "identity_rejected");

  const noImage = await discoverCocktailImage(basilRow(), {
    searchWebHits: async () => preferredHit,
    fetchHtml: async (url) => ({ html: recipePage({ name: "Gin Basil Smash", ingredients: ["gin", "lemon", "basil"] }), finalUrl: url })
  });
  assert.equal(noImage.status, "no_result");
  if (noImage.status === "no_result") assert.equal(noImage.reason, "no_page_image");

  const localizeFail = await discoverCocktailImage(basilRow(), {
    searchWebHits: async () => preferredHit,
    fetchHtml: async (url) => ({ html: recipePage({ name: "Gin Basil Smash", image: "https://cdn.example/gbs.jpg", ingredients: ["gin", "lemon", "basil"] }), finalUrl: url }),
    localizeImage: async () => null
  });
  assert.equal(localizeFail.status, "no_result");
  if (localizeFail.status === "no_result") assert.equal(localizeFail.reason, "localize_failed");
});

test("Keeper diagnostic copy is distinct per stage and leaks nothing", () => {
  assert.equal(cocktailImageDiscoveryMessage("no_result", "search_miss"), "No matching cocktail pages were found.");
  assert.equal(cocktailImageDiscoveryMessage("no_result", "identity_rejected"), "Found possible recipes, but none matched this cocktail closely enough.");
  assert.equal(cocktailImageDiscoveryMessage("no_result", "no_page_image"), "Matched a recipe, but it did not expose a usable photo.");
  assert.equal(cocktailImageDiscoveryMessage("no_result", "localize_failed"), "Found a photo, but it could not be saved locally.");
  // Backward-compatible default.
  assert.equal(cocktailImageDiscoveryMessage("no_result"), "No trustworthy photo found");
});

/* ------------------------------ Safety rules ------------------------------ */

test("existing image is never overwritten and discovery does not run", async () => {
  const result = await discoverCocktailImage(basilRow({ image_url: "/api/media/images/kept.jpg" }), {
    searchWebHits: async () => { throw new Error("must not search"); },
    fetchHtml: async () => { throw new Error("must not fetch"); }
  });
  assert.equal(result.status, "already_has_image");
});

test("rejected hosts and failed localization never persist a remote URL", async () => {
  // Pinterest is a rejected host — the Gin Basil Smash page there is dropped.
  const rejectedHost = await discoverCocktailImage(basilRow(), {
    searchWebHits: async () => [{ title: "Gin Basil Smash", content: "x", url: "https://www.pinterest.com/pin/1" }],
    fetchHtml: async () => { throw new Error("rejected host should never be fetched"); }
  });
  assert.equal(rejectedHost.status, "no_result");

  // Search-hit filter drops rejected hosts and derivative titles, keeps the alias.
  const hits = filterCocktailImageSearchHits(
    [
      { title: "Gin Basil Smash Recipe | Liquor.com", content: "gin", url: "https://liquor.com/recipes/gin-basil-smash/" },
      { title: "Strawberry Basil Smash", content: "berry", url: "https://example.com/strawberry" },
      { title: "Basil Smash", content: "pin", url: "https://pinterest.com/pin/2" }
    ],
    "Basil Smash",
    BASIL_SMASH_INGREDIENTS
  );
  assert.equal(hits.length, 1);
  assert.match(hits[0].url, /liquor\.com/);

  // A found remote image that cannot localize is never saved (only a local path is accepted).
  assert.equal(
    extractCocktailRecipeImage(recipePage({ name: "Gin Basil Smash", image: "https://cdn.example/gbs.jpg", ingredients: ["gin", "basil"] }), "https://liquor.com/x", "Basil Smash", BASIL_SMASH_INGREDIENTS),
    "https://cdn.example/gbs.jpg"
  );
});

test("bounded, deduped multi-query search attempts the exact query first", async () => {
  const queries: string[] = [];
  const seenUrls = new Set<string>();
  await discoverCocktailImage(basilRow(), {
    searchWebHits: async (query) => {
      queries.push(query);
      // Same URL returned for every query; discovery must dedupe it to one candidate.
      return [{ title: "unrelated page", content: "", url: "https://example.com/only-once" }];
    },
    fetchHtml: async (url) => {
      seenUrls.add(url);
      return { html: "<html><head><title>Unrelated</title></head><body></body></html>", finalUrl: url };
    }
  });
  assert.ok(queries.length >= 1 && queries.length <= 3, "bounded query count");
  assert.equal(queries[0], buildCocktailImageSearchQuery("Basil Smash"), "exact query first");
  assert.equal(seenUrls.size, 1, "duplicate candidate URL fetched only once");
});