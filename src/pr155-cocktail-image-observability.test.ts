/**
 * PR155 — Cocktail image discovery observability + production reliability.
 * French 75 regression, SERP pre-filter softening, signature queries,
 * structured image extraction, candidate budget, Keeper-only diagnostics.
 * Fixtures/stubs only — does not claim live SearXNG verification.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const {
  buildCocktailImageQueryPlan,
  classifyCocktailIdentity,
  cocktailIdentityAccepted,
  isDerivativeCocktailSearchTitle,
  signatureIngredientsForSearch,
  softTitleCocktailIdentity
} = await import("./cocktail-image-identity.js");
const {
  discoverCocktailImage,
  extractCocktailRecipeImage,
  filterCocktailImageSearchHits,
  isRejectedCocktailImageAssetHost,
  pageIdentifiesCocktail
} = await import("./cocktail_image.js");
const {
  cocktailImageDiscoveryDiagnosticLines,
  cocktailImageDiscoveryMessage
} = await import("../client/src/cocktail-image-ui.ts");

const FRENCH_75_INGREDIENTS = [
  "60 ml gin",
  "22 ml lemon juice",
  "22 ml sugar syrup",
  "90 ml champagne"
];

function recipePage(args: {
  name: string;
  image?: unknown;
  ogImage?: string;
  ingredients?: string[];
  title?: string;
  heading?: string;
  graph?: boolean;
}): string {
  const node: Record<string, unknown> = {
    "@type": "Recipe",
    name: args.name,
    recipeInstructions: "Shake, strain, top with champagne."
  };
  if (args.image !== undefined) node.image = args.image;
  if (args.ingredients) node.recipeIngredient = args.ingredients;
  const payload = args.graph
    ? { "@context": "https://schema.org", "@graph": [node] }
    : { "@context": "https://schema.org", ...node };
  const og = args.ogImage ? `<meta property="og:image" content="${args.ogImage}">` : "";
  const title = args.title ?? `${args.name} Cocktail Recipe | Example`;
  const heading = args.heading ?? args.name;
  return `<!doctype html><html><head><title>${title}</title>${og}
    <script type="application/ld+json">${JSON.stringify(payload)}</script>
    </head><body><h1>${heading}</h1></body></html>`;
}

test("French 75 signature ingredients prefer gin, champagne, lemon", () => {
  const sig = signatureIngredientsForSearch(FRENCH_75_INGREDIENTS, "French 75");
  assert.deepEqual(sig, ["gin", "champagne", "lemon"]);
});

test("French 75 query plan is bounded and signature-aware", () => {
  const plan = buildCocktailImageQueryPlan(
    "French 75",
    FRENCH_75_INGREDIENTS,
    "French 75 cocktail recipe"
  );
  assert.equal(plan[0], "French 75 cocktail recipe");
  assert.ok(plan.length >= 2 && plan.length <= 3);
  assert.ok(plan.some((q) => /gin/i.test(q)));
  assert.ok(plan.some((q) => /champagne|lemon/i.test(q)));
  assert.equal(new Set(plan).size, plan.length);
});

test("SERP titles with descriptive boilerplate remain eligible for page inspection", () => {
  const titles = [
    "Classic French 75 Cocktail",
    "The French 75 Recipe",
    "How to Make a French 75",
    "French 75 Cocktail Recipe | Publisher",
    "French 75 Cocktail Recipe - Serious Eats"
  ];
  for (const title of titles) {
    assert.equal(
      isDerivativeCocktailSearchTitle(title, "French 75", FRENCH_75_INGREDIENTS),
      false,
      title
    );
  }
  const hits = filterCocktailImageSearchHits(
    titles.map((title, i) => ({
      title,
      url: `https://www.seriouseats.com/french-75-${i}`,
      content: "cocktail recipe"
    })),
    "French 75",
    FRENCH_75_INGREDIENTS
  );
  assert.equal(hits.length, titles.length);
});

test("French 75 flavored/numbered derivatives are rejected by SERP pre-filter", () => {
  for (const title of [
    "Elderflower French 75",
    "Strawberry French 75",
    "Lavender French 75",
    "French 76",
    "French 95"
  ]) {
    assert.equal(
      isDerivativeCocktailSearchTitle(title, "French 75", FRENCH_75_INGREDIENTS),
      true,
      title
    );
  }
});

test("page identity accepts French 75 Recipe forms and rejects derivatives", () => {
  const ok = recipePage({
    name: "French 75 Recipe",
    image: "https://cdn.example.com/french75.jpg",
    ingredients: FRENCH_75_INGREDIENTS
  });
  assert.equal(pageIdentifiesCocktail(ok, "French 75", FRENCH_75_INGREDIENTS), true);

  const derivative = recipePage({
    name: "Elderflower French 75",
    image: "https://cdn.example.com/elder.jpg",
    ingredients: [...FRENCH_75_INGREDIENTS, "elderflower liqueur"]
  });
  assert.equal(pageIdentifiesCocktail(derivative, "French 75", FRENCH_75_INGREDIENTS), false);
});

test("structured image extraction covers string, array, ImageObject, @graph, OG", () => {
  const base = "https://www.seriouseats.com/french-75";
  assert.match(
    extractCocktailRecipeImage(
      recipePage({ name: "French 75", image: "https://cdn.example.com/a.jpg", ingredients: FRENCH_75_INGREDIENTS }),
      base,
      "French 75",
      FRENCH_75_INGREDIENTS
    ),
    /cdn\.example\.com\/a\.jpg/
  );
  assert.match(
    extractCocktailRecipeImage(
      recipePage({
        name: "French 75",
        image: ["https://cdn.example.com/b.jpg", "https://cdn.example.com/b2.jpg"],
        ingredients: FRENCH_75_INGREDIENTS
      }),
      base,
      "French 75",
      FRENCH_75_INGREDIENTS
    ),
    /cdn\.example\.com\/b\.jpg/
  );
  assert.match(
    extractCocktailRecipeImage(
      recipePage({
        name: "French 75",
        image: { "@type": "ImageObject", contentUrl: "https://cdn.example.com/c.jpg" },
        ingredients: FRENCH_75_INGREDIENTS
      }),
      base,
      "French 75",
      FRENCH_75_INGREDIENTS
    ),
    /cdn\.example\.com\/c\.jpg/
  );
  assert.match(
    extractCocktailRecipeImage(
      recipePage({
        name: "French 75",
        image: "https://cdn.example.com/d.jpg",
        ingredients: FRENCH_75_INGREDIENTS,
        graph: true
      }),
      base,
      "French 75",
      FRENCH_75_INGREDIENTS
    ),
    /cdn\.example\.com\/d\.jpg/
  );
  assert.match(
    extractCocktailRecipeImage(
      recipePage({
        name: "French 75",
        ogImage: "https://cdn.example.com/og.jpg",
        ingredients: FRENCH_75_INGREDIENTS
      }),
      base,
      "French 75",
      FRENCH_75_INGREDIENTS
    ),
    /cdn\.example\.com\/og\.jpg/
  );
});

test("image asset host policy allows publisher CDNs and rejects stock/retailer/content hosts", () => {
  assert.equal(isRejectedCocktailImageAssetHost("https://cdn.seriouseats.com/french75.jpg"), false);
  for (const url of [
    "https://i.pinimg.com/x.jpg",
    "https://www.shutterstock.com/image.jpg",
    "https://www.amazon.com/images/I/french75.jpg",
    "https://www.walmart.com/images/french75.jpg",
    "https://www.ebay.com/images/french75.jpg",
    "https://www.etsy.com/images/french75.jpg",
    "https://www.target.com/images/french75.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/french75.jpg",
    "https://en.wikipedia.org/wiki/Special:FilePath/French_75.jpg",
    "https://mybar.blogspot.com/french75.jpg",
    "https://mybar.wordpress.com/french75.jpg",
    "https://medium.com/@author/french75.jpg",
    "https://author.substack.com/french75.jpg",
    "https://www.quora.com/images/french75.jpg"
  ]) {
    assert.equal(isRejectedCocktailImageAssetHost(url), true, url);
  }
});

test("accepted recipe page with prohibited image asset yields no_page_image and never localizes", async () => {
  const prohibitedImages = [
    "https://www.amazon.com/images/I/french75.jpg",
    "https://www.walmart.com/images/french75.jpg",
    "https://i.pinimg.com/originals/french75.jpg",
    "https://www.shutterstock.com/image-photo/french-75.jpg"
  ];

  for (const image of prohibitedImages) {
    let localizeCalls = 0;
    const html = recipePage({
      name: "French 75",
      image,
      ingredients: FRENCH_75_INGREDIENTS,
      title: "French 75 Cocktail Recipe | Serious Eats"
    });
    const result = await discoverCocktailImage(
      {
        id: 11,
        name: "French 75",
        ingredients: FRENCH_75_INGREDIENTS.join("\n"),
        image_url: null,
        source_url: null
      },
      {
        searchWebHits: async () => [
          {
            title: "French 75 Cocktail Recipe",
            url: "https://www.seriouseats.com/french-75",
            content: "cocktail recipe"
          }
        ],
        fetchHtml: async (url) => ({ html, finalUrl: url }),
        localizeImage: async () => {
          localizeCalls += 1;
          return "/api/media/images/cocktails/french-75.jpg";
        }
      }
    );
    assert.equal(result.status, "no_result", image);
    if (result.status === "no_result") {
      assert.equal(result.reason, "no_page_image", image);
      assert.ok((result.diagnostics?.image_host_rejects ?? 0) >= 1, image);
      assert.equal(result.diagnostics?.localize_attempts ?? 0, 0, image);
    }
    assert.equal(localizeCalls, 0, `localize must not run for ${image}`);
  }
});

test("French 75 positive path: search → page → image → localize", async () => {
  const html = recipePage({
    name: "French 75",
    image: { "@type": "ImageObject", url: "https://cdn.seriouseats.com/french75.jpg" },
    ingredients: FRENCH_75_INGREDIENTS,
    title: "Classic French 75 Cocktail Recipe | Serious Eats"
  });
  const result = await discoverCocktailImage(
    {
      id: 1,
      name: "French 75",
      ingredients: FRENCH_75_INGREDIENTS.join("\n"),
      image_url: null,
      source_url: null
    },
    {
      searchWebHits: async () => [
        { title: "Elderflower French 75", url: "https://www.liquor.com/elderflower-french-75", content: "recipe" },
        { title: "Classic French 75 Cocktail Recipe", url: "https://www.seriouseats.com/french-75", content: "recipe" }
      ],
      fetchHtml: async (url) => ({ html, finalUrl: url }),
      localizeImage: async () => "/api/media/images/cocktails/french-75.jpg"
    }
  );
  assert.equal(result.status, "updated");
  if (result.status === "updated") {
    assert.equal(result.image_url, "/api/media/images/cocktails/french-75.jpg");
    assert.ok(result.diagnostics);
    assert.equal(result.diagnostics?.stage, "updated");
    assert.ok((result.diagnostics?.identity_matches ?? 0) >= 1);
    assert.ok((result.diagnostics?.pages_with_image ?? 0) >= 1);
  }
});

test("candidate budget is not consumed only by early rejected/duplicate hits", async () => {
  const html = recipePage({
    name: "French 75",
    image: "https://cdn.seriouseats.com/french75.jpg",
    ingredients: FRENCH_75_INGREDIENTS
  });
  const junk = Array.from({ length: 8 }, (_, i) => ({
    title: `Random cocktail ${i}`,
    url: `https://www.pinterest.com/pin/${i}`,
    content: "photo"
  }));
  let queries = 0;
  const result = await discoverCocktailImage(
    {
      id: 2,
      name: "French 75",
      ingredients: FRENCH_75_INGREDIENTS.join("\n"),
      image_url: null,
      source_url: null
    },
    {
      maxCandidates: 4,
      searchWebHits: async () => {
        queries += 1;
        if (queries === 1) return junk;
        return [
          ...junk,
          {
            title: "French 75 Cocktail Recipe",
            url: "https://www.seriouseats.com/french-75",
            content: "recipe"
          }
        ];
      },
      fetchHtml: async (url) => ({ html, finalUrl: url }),
      localizeImage: async () => "/api/media/images/cocktails/french-75.jpg"
    }
  );
  assert.equal(result.status, "updated");
  assert.ok(queries >= 2, "later queries must run even when early hits are junk");
});

test("diagnostics stages cover search/identity/image/localize failures", async () => {
  const baseRow = {
    id: 3,
    name: "French 75",
    ingredients: FRENCH_75_INGREDIENTS.join("\n"),
    image_url: null,
    source_url: null
  };

  const searchFailed = await discoverCocktailImage(baseRow, {
    searchWebHits: async () => {
      throw new Error("down");
    }
  });
  assert.equal(searchFailed.status, "no_result");
  if (searchFailed.status === "no_result") {
    assert.equal(searchFailed.reason, "search_failed");
    assert.equal(searchFailed.diagnostics?.stage, "search_failed");
  }

  const searchMiss = await discoverCocktailImage(baseRow, {
    searchWebHits: async () => []
  });
  assert.equal(searchMiss.status, "no_result");
  if (searchMiss.status === "no_result") {
    assert.equal(searchMiss.reason, "search_miss");
    assert.match(String(searchMiss.diagnostics?.note ?? ""), /reachable|usable recipe pages/i);
  }

  const identity = await discoverCocktailImage(baseRow, {
    searchWebHits: async () => [
      { title: "French 75 Cocktail", url: "https://www.seriouseats.com/x", content: "recipe" }
    ],
    fetchHtml: async () => ({
      html: recipePage({
        name: "Strawberry French 75",
        image: "https://cdn.example.com/x.jpg",
        ingredients: [...FRENCH_75_INGREDIENTS, "strawberry"]
      }),
      finalUrl: "https://www.seriouseats.com/x"
    })
  });
  assert.equal(identity.status, "no_result");
  if (identity.status === "no_result") {
    assert.equal(identity.reason, "identity_rejected");
    assert.ok((identity.diagnostics?.identity_rejects ?? 0) >= 1);
  }

  const noImage = await discoverCocktailImage(baseRow, {
    searchWebHits: async () => [
      { title: "French 75 Cocktail", url: "https://www.seriouseats.com/x", content: "recipe" }
    ],
    fetchHtml: async () => ({
      html: recipePage({ name: "French 75", ingredients: FRENCH_75_INGREDIENTS }),
      finalUrl: "https://www.seriouseats.com/x"
    })
  });
  assert.equal(noImage.status, "no_result");
  if (noImage.status === "no_result") {
    assert.equal(noImage.reason, "no_page_image");
  }

  const localize = await discoverCocktailImage(baseRow, {
    searchWebHits: async () => [
      { title: "French 75 Cocktail", url: "https://www.seriouseats.com/x", content: "recipe" }
    ],
    fetchHtml: async () => ({
      html: recipePage({
        name: "French 75",
        image: "https://cdn.seriouseats.com/french75.jpg",
        ingredients: FRENCH_75_INGREDIENTS
      }),
      finalUrl: "https://www.seriouseats.com/x"
    }),
    localizeImage: async () => null
  });
  assert.equal(localize.status, "no_result");
  if (localize.status === "no_result") {
    assert.equal(localize.reason, "localize_failed");
    assert.ok((localize.diagnostics?.localize_failures ?? 0) >= 1);
  }
});

test("existing image is never overwritten", async () => {
  let searched = false;
  const result = await discoverCocktailImage(
    {
      id: 9,
      name: "French 75",
      ingredients: FRENCH_75_INGREDIENTS.join("\n"),
      image_url: "/api/media/images/cocktails/existing.jpg",
      source_url: null
    },
    {
      searchWebHits: async () => {
        searched = true;
        return [];
      }
    }
  );
  assert.equal(result.status, "already_has_image");
  assert.equal(searched, false);
});

test("Keeper diagnostic lines stay bounded; Guest copy has no diagnostics leakage", () => {
  const lines = cocktailImageDiscoveryDiagnosticLines({
    cocktail_name: "French 75",
    queries_tried: 3,
    raw_results: 14,
    candidates_after_dedupe: 6,
    identity_matches: 2,
    pages_with_image: 1,
    localize_failures: 1,
    stage: "localize_failed",
    note: "SearXNG is reachable, but this search returned no usable recipe pages."
  });
  assert.ok(lines.length >= 4 && lines.length <= 12);
  assert.ok(lines.some((l) => /Queries tried: 3/.test(l)));
  assert.ok(!lines.some((l) => /cookie|authorization|html|secret/i.test(l)));
  assert.equal(cocktailImageDiscoveryDiagnosticLines(null).length, 0);
  assert.match(cocktailImageDiscoveryMessage("no_result", "search_miss"), /matching cocktail pages/i);
});

test("soft title keeps hyphenated modifiers for page identity", () => {
  assert.notEqual(softTitleCocktailIdentity("Old Fashioned – Smoked Version"), "old fashioned");
  assert.equal(
    cocktailIdentityAccepted(
      classifyCocktailIdentity({
        target: "Old Fashioned",
        candidate: "Old Fashioned – Smoked Version"
      })
    ),
    false
  );
});
