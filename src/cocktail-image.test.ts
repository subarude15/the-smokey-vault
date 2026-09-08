/**
 * PR129 — Cocktail recipe imagery: identity gates, import extraction,
 * fill-missing discovery, Keeper route, and UI eligibility.
 * Fixtures/stubs only — no live SearXNG or remote image hosts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { db } = await import("./db.js");
const { saveImageBuffer } = await import("./images.js");
const {
  acceptLocalizedCocktailImage,
  buildCocktailImageSearchQuery,
  cocktailHasImage,
  cocktailNamesMatchExact,
  discoverCocktailImage,
  enrichImportedRecipeImage,
  extractCocktailRecipeImage,
  filterCocktailImageSearchHits,
  findCocktailImage,
  isRejectedCocktailImageHost,
  normalizeCocktailName,
  pageIdentifiesCocktail,
  softTitleCocktailIdentity
} = await import("./cocktail_image.js");
const { parseRecipeHtml } = await import("./recipe_import.js");
const { app, createTestAdminToken } = await import("./server.js");
const {
  canFindCocktailPhoto,
  cocktailImageDiscoveryMessage
} = await import("../client/src/cocktail-image-ui.ts");

const PREFIX = `PR129-${Date.now()}`;

function recipePage(args: {
  name: string;
  image?: string;
  ogImage?: string;
  title?: string;
  heading?: string;
  includeIngredients?: boolean;
}): string {
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: args.name,
    ...(args.image ? { image: args.image } : {}),
    ...(args.includeIngredients === false
      ? {}
      : {
          recipeIngredient: ["30 ml gin", "30 ml vermouth"],
          recipeInstructions: "Stir with ice."
        })
  });
  const og = args.ogImage
    ? `<meta property="og:image" content="${args.ogImage}">`
    : "";
  const title = args.title ?? `${args.name} Cocktail Recipe | Example`;
  const heading = args.heading ?? args.name;
  return `<!doctype html><html><head><title>${title}</title>${og}
    <script type="application/ld+json">${jsonLd}</script>
    </head><body><h1>${heading}</h1><img src="/logo.png" alt="site logo"></body></html>`;
}

function insertCocktail(fields: {
  name: string;
  image_url?: string;
  source_url?: string;
  notes?: string;
}): number {
  const result = db.prepare(
    `INSERT INTO cocktails(name,collection,ingredients,glassware,garnish,method,notes,season,image_url,source_url)
     VALUES(?, 'Custom Cocktails', ?, 'Coupe', '', 'Stir', ?, 'All', ?, ?)`
  ).run(
    fields.name,
    JSON.stringify(["30 ml gin", "30 ml vermouth"]),
    fields.notes ?? "",
    fields.image_url ?? "",
    fields.source_url ?? ""
  );
  return Number(result.lastInsertRowid);
}

function cleanupCocktail(name: string) {
  db.prepare("DELETE FROM cocktails WHERE name=?").run(name);
}

test("identity: punctuation/case-normalized exact match accepted", () => {
  assert.equal(normalizeCocktailName("Old-Fashioned"), "old fashioned");
  assert.equal(normalizeCocktailName("old fashioned"), "old fashioned");
  assert.equal(cocktailNamesMatchExact("Old-Fashioned", "old fashioned"), true);
  assert.equal(cocktailNamesMatchExact("Paper Plane", "paper plane"), true);
});

test("identity: derivative cocktail rejected", () => {
  assert.equal(cocktailNamesMatchExact("Smoked Old Fashioned", "Old Fashioned"), false);
  assert.equal(cocktailNamesMatchExact("Chocolate Old Fashioned", "Old Fashioned"), false);
  assert.equal(softTitleCocktailIdentity("Smoked Old Fashioned Recipe | Blog"), "smoked old fashioned");
  assert.equal(
    pageIdentifiesCocktail(
      recipePage({ name: "Smoked Old Fashioned", image: "https://cdn.example/smoked.jpg" }),
      "Old Fashioned"
    ),
    false
  );
});

test("identity: dash suffix modifiers are not stripped from titles/headings", () => {
  // Hyphen, en-dash, and em-dash suffixes must remain part of identity.
  assert.equal(
    softTitleCocktailIdentity("Old Fashioned - Peach"),
    "old fashioned peach"
  );
  assert.equal(
    softTitleCocktailIdentity("Old Fashioned – Smoked Version"),
    "old fashioned smoked version"
  );
  assert.equal(
    softTitleCocktailIdentity("Old Fashioned — Maple & Bacon"),
    "old fashioned maple and bacon"
  );
  assert.equal(
    softTitleCocktailIdentity("Negroni – Strawberry Variation"),
    "negroni strawberry variation"
  );
  assert.notEqual(softTitleCocktailIdentity("Old Fashioned – Smoked Version"), "old fashioned");

  // Site-title separators still drop publisher branding.
  assert.equal(
    softTitleCocktailIdentity("Old Fashioned Cocktail Recipe | Liquor.com"),
    "old fashioned"
  );
  assert.equal(
    softTitleCocktailIdentity("Old Fashioned Cocktail Recipe · Punch"),
    "old fashioned"
  );

  // Plain accepted forms still normalize correctly.
  assert.equal(softTitleCocktailIdentity("Old Fashioned"), "old fashioned");
  assert.equal(softTitleCocktailIdentity("Old-Fashioned"), "old fashioned");
  assert.equal(softTitleCocktailIdentity("Old Fashioned Cocktail Recipe"), "old fashioned");
  assert.equal(softTitleCocktailIdentity("How to Make Old Fashioned"), "old fashioned");

  // Heading with dash modifier must not identify the plain drink (no exact JSON-LD).
  const smokedHeadingHtml = `
    <html><head><title>Blog Post</title></head>
    <body><h1>Old Fashioned – Smoked Version</h1></body></html>`;
  assert.equal(pageIdentifiesCocktail(smokedHeadingHtml, "Old Fashioned"), false);

  for (const title of [
    "Old Fashioned - Peach",
    "Old Fashioned – Smoked Version",
    "Old Fashioned — Maple & Bacon",
    "Negroni – Strawberry Variation",
    "Manhattan — Black Walnut Version",
    "Margarita – Spicy Jalapeño",
    "Martini - Espresso Twist"
  ]) {
    const html = recipePage({
      name: title,
      image: "https://cdn.example/derivative.jpg",
      title,
      heading: title
    });
    const target = title.startsWith("Negroni")
      ? "Negroni"
      : title.startsWith("Manhattan")
        ? "Manhattan"
        : title.startsWith("Margarita")
          ? "Margarita"
          : title.startsWith("Martini")
            ? "Martini"
            : "Old Fashioned";
    assert.equal(pageIdentifiesCocktail(html, target), false, title);
  }

  // Exact Recipe JSON-LD for the plain drink still identifies even with a noisy page title.
  const exactLdNoisyTitle = recipePage({
    name: "Old Fashioned",
    image: "https://cdn.example/of.jpg",
    title: "Old Fashioned – Smoked Version | Example",
    heading: "Something Else"
  });
  assert.equal(pageIdentifiesCocktail(exactLdNoisyTitle, "Old Fashioned"), true);
});

test("identity: exact cocktail page name accepted via JSON-LD / title", () => {
  const html = recipePage({
    name: "Negroni",
    image: "https://cdn.example/negroni.jpg",
    title: "Negroni Cocktail Recipe | Liquor.com"
  });
  assert.equal(pageIdentifiesCocktail(html, "Negroni"), true);
  assert.equal(pageIdentifiesCocktail(html, "negroni"), true);
  assert.equal(
    extractCocktailRecipeImage(html, "https://liquor.com/recipes/negroni/", "Negroni"),
    "https://cdn.example/negroni.jpg"
  );
});

test("identity: unrelated page rejected", () => {
  const html = recipePage({
    name: "Manhattan",
    image: "https://cdn.example/manhattan.jpg",
    title: "Manhattan Cocktail Recipe"
  });
  assert.equal(pageIdentifiesCocktail(html, "Negroni"), false);
});

test("imported source image: JSON-LD preferred over decorative img; OG fallback", () => {
  const withLd = recipePage({
    name: "Paper Plane",
    image: "https://cdn.example/plane.jpg",
    ogImage: "https://cdn.example/og-plane.jpg"
  });
  const parsed = parseRecipeHtml(withLd, "https://punchdrink.com/recipes/paper-plane/");
  assert.equal(parsed.image_url, "https://cdn.example/plane.jpg");

  const ogOnly = `
    <meta property="og:image" content="/hero.png">
    <script type="application/ld+json">
      {"@type":"Recipe","name":"Gimlet","recipeIngredient":["60 ml gin","30 ml lime cordial"],"recipeInstructions":"Shake."}
    </script>
    <img src="/site-logo.png" alt="logo">`;
  const gimlet = parseRecipeHtml(ogOnly, "https://example.com/gimlet");
  assert.equal(gimlet.image_url, "https://example.com/hero.png");

  const empty = enrichImportedRecipeImage(
    {
      name: "Gimlet",
      ingredients: ["gin"],
      method: "Shake",
      glassware: "Coupe",
      garnish: "",
      season: "All",
      notes: "",
      image_url: "",
      source_url: "https://example.com/gimlet"
    },
    ogOnly,
    "https://example.com/gimlet"
  );
  assert.equal(empty.image_url, "https://example.com/hero.png");

  const preserved = enrichImportedRecipeImage(
    { ...empty, image_url: "https://keeper.example/kept.jpg" },
    withLd,
    "https://punchdrink.com/recipes/paper-plane/"
  );
  assert.equal(preserved.image_url, "https://keeper.example/kept.jpg");
});

test("existing image_url is never overwritten by discovery", async () => {
  const name = `${PREFIX}-has-image`;
  cleanupCocktail(name);
  const id = insertCocktail({
    name,
    image_url: "/api/media/images/existing.jpg",
    source_url: "https://liquor.com/recipes/negroni/"
  });
  const result = await discoverCocktailImage(
    { id, name, image_url: "/api/media/images/existing.jpg", source_url: "https://liquor.com/recipes/negroni/" },
    {
      searchWebHits: async () => {
        throw new Error("search should not run when image exists");
      },
      fetchHtml: async () => {
        throw new Error("fetch should not run when image exists");
      }
    }
  );
  assert.equal(result.status, "already_has_image");
  if (result.status === "already_has_image") {
    assert.equal(result.image_url, "/api/media/images/existing.jpg");
  }
  const row = db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(id) as { image_url: string };
  assert.equal(row.image_url, "/api/media/images/existing.jpg");
  cleanupCocktail(name);
});

test("no trustworthy source returns no_result without DB mutation", async () => {
  const name = `${PREFIX}-no-result`;
  cleanupCocktail(name);
  const id = insertCocktail({ name, image_url: "" });
  const before = db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(id) as { image_url: string };
  const result = await findCocktailImage(id, {
    searchWebHits: async () => [
      {
        title: "Smoked Old Fashioned Recipe",
        content: "A smoked twist",
        url: "https://pinterest.com/pin/123"
      },
      {
        title: "Random cocktail blog",
        content: "drinks",
        url: "https://unsplash.com/photos/xyz"
      }
    ],
    fetchHtml: async () => ({
      html: recipePage({ name: "Smoked Old Fashioned", image: "https://cdn.example/x.jpg" }),
      finalUrl: "https://example.com/smoked"
    }),
    localizeImage: async () => "/api/media/images/should-not-save.jpg"
  });
  assert.equal(result.status, "no_result");
  const after = db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(id) as { image_url: string };
  assert.equal(after.image_url, before.image_url);
  assert.equal(after.image_url, "");
  cleanupCocktail(name);
});

test("discovery updates missing image from exact-match preferred source", async () => {
  const name = `${PREFIX}-find-ok`;
  cleanupCocktail(name);
  const cocktailId = insertCocktail({ name, image_url: "" });

  const result = await findCocktailImage(cocktailId, {
    searchWebHits: async () => [
      {
        title: `${name} Cocktail Recipe | Liquor.com`,
        content: "Classic equal parts",
        url: "https://liquor.com/recipes/test-negroni/"
      }
    ],
    fetchHtml: async (url) => ({
      html: recipePage({
        name,
        image: "https://cdn.example/negroni.jpg",
        title: `${name} Cocktail Recipe | Liquor.com`
      }),
      finalUrl: url
    }),
    localizeImage: async () => "/api/media/images/negroni-local.jpg"
  });
  assert.equal(result.status, "updated");
  if (result.status === "updated") {
    assert.equal(result.image_url, "/api/media/images/negroni-local.jpg");
  }
  const row = db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(cocktailId) as {
    image_url: string;
  };
  assert.equal(row.image_url, "/api/media/images/negroni-local.jpg");
  cleanupCocktail(name);
});

test("source_url page is tried before search and does not need a second fuzzy search", async () => {
  const name = `${PREFIX}-source-first`;
  cleanupCocktail(name);
  const id = insertCocktail({
    name,
    image_url: "",
    source_url: "https://punchdrink.com/recipes/source-first/"
  });
  let searched = false;
  const result = await discoverCocktailImage(
    { id, name, image_url: "", source_url: "https://punchdrink.com/recipes/source-first/" },
    {
      searchWebHits: async () => {
        searched = true;
        return [];
      },
      fetchHtml: async (url) => {
        assert.match(url, /punchdrink\.com/);
        return {
          html: recipePage({
            name,
            image: "https://cdn.example/from-source.jpg",
            title: `${name} Cocktail`
          }),
          finalUrl: url
        };
      },
      localizeImage: async () => "/api/media/images/from-source.jpg"
    }
  );
  assert.equal(result.status, "updated");
  assert.equal(searched, false);
  cleanupCocktail(name);
});

test("rejected hosts include stock / social aggregators", () => {
  assert.equal(isRejectedCocktailImageHost("https://www.pinterest.com/pin/1"), true);
  assert.equal(isRejectedCocktailImageHost("https://unsplash.com/photos/x"), true);
  assert.equal(isRejectedCocktailImageHost("https://www.instagram.com/p/x"), true);
  assert.equal(isRejectedCocktailImageHost("https://liquor.com/recipes/negroni/"), false);
});

test("search hit filter drops derivative titles and rejected hosts", () => {
  const hits = filterCocktailImageSearchHits(
    [
      {
        title: "Smoked Old Fashioned Recipe",
        content: "twist",
        url: "https://example.com/smoked"
      },
      {
        title: "Old Fashioned Cocktail Recipe",
        content: "classic",
        url: "https://pinterest.com/pin/1"
      },
      {
        title: "Old Fashioned Cocktail Recipe | Liquor.com",
        content: "classic whiskey",
        url: "https://liquor.com/recipes/old-fashioned/"
      }
    ],
    "Old Fashioned"
  );
  assert.equal(hits.length, 1);
  assert.match(hits[0].url, /liquor\.com/);
});

test("acceptLocalizedCocktailImage never keeps remote hotlinks", () => {
  assert.equal(acceptLocalizedCocktailImage("https://cdn.example/x.jpg"), "");
  assert.equal(
    acceptLocalizedCocktailImage("/api/media/images/x.jpg", "https://cdn.example/x.jpg"),
    "/api/media/images/x.jpg"
  );
  assert.equal(cocktailHasImage({ image_url: "  " }), false);
  assert.equal(cocktailHasImage({ image_url: "/api/media/images/x.jpg" }), true);
  assert.match(buildCocktailImageSearchQuery("Paper Plane"), /Paper Plane cocktail recipe/);
});

test("Keeper route: Guest cannot invoke find-image", async () => {
  const name = `${PREFIX}-auth`;
  cleanupCocktail(name);
  const id = insertCocktail({ name, image_url: "" });
  const denied = await app.inject({
    method: "POST",
    url: `/api/cocktails/${id}/find-image`,
    payload: {}
  });
  assert.equal(denied.statusCode, 401);
  cleanupCocktail(name);
});

test("Keeper route: valid request updates missing image; existing returns already_has_image", async () => {
  const name = `${PREFIX}-route`;
  cleanupCocktail(name);
  const token = createTestAdminToken();
  const prevSearx = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = "http://127.0.0.1:9/search";

  try {
    const withImage = insertCocktail({
      name: `${name}-has`,
      image_url: "/api/media/images/kept.jpg"
    });
    const hasRes = await app.inject({
      method: "POST",
      url: `/api/cocktails/${withImage}/find-image`,
      headers: { authorization: `Bearer ${token}` },
      payload: {}
    });
    assert.equal(hasRes.statusCode, 200);
    const hasBody = hasRes.json() as { status: string; image_url?: string };
    assert.equal(hasBody.status, "already_has_image");
    assert.equal(hasBody.image_url, "/api/media/images/kept.jpg");

    const missing = insertCocktail({ name: `${name}-miss`, image_url: "" });
    const missRes = await app.inject({
      method: "POST",
      url: `/api/cocktails/${missing}/find-image`,
      headers: { authorization: `Bearer ${token}` },
      payload: {}
    });
    assert.equal(missRes.statusCode, 200);
    const missBody = missRes.json() as { status: string };
    // Without a reachable SearXNG, expect no_result — still a valid outcome.
    assert.ok(missBody.status === "no_result" || missBody.status === "updated");
    const row = db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(missing) as {
      image_url: string;
    };
    if (missBody.status === "no_result") {
      assert.equal(row.image_url, "");
    }

    cleanupCocktail(`${name}-has`);
    cleanupCocktail(`${name}-miss`);
  } finally {
    if (prevSearx === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = prevSearx;
  }
});

test("custom save preserves existing image_url on conflict; image failure does not fail import", async () => {
  const name = `${PREFIX}-save`;
  cleanupCocktail(name);
  const token = createTestAdminToken();
  const tinyJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z",
    "base64"
  );
  const local = saveImageBuffer(tinyJpeg, "image/jpeg", "seed.jpg");
  insertCocktail({ name, image_url: local });

  const res = await app.inject({
    method: "POST",
    url: "/api/cocktails/custom",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name,
      ingredients: ["1 oz gin"],
      method: "Stir",
      glassware: "Coupe",
      garnish: "",
      season: "All",
      notes: "updated notes",
      image_url: "https://example.invalid/should-not-replace.jpg",
      source_url: "https://example.com/recipe"
    }
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { image_url: string; notes: string };
  assert.equal(body.image_url, local);

  // Brand-new recipe with a failing remote image still saves with empty image_url.
  const name2 = `${PREFIX}-save-fail-img`;
  cleanupCocktail(name2);
  const res2 = await app.inject({
    method: "POST",
    url: "/api/cocktails/custom",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: name2,
      ingredients: ["1 oz gin"],
      method: "Shake",
      glassware: "Coupe",
      garnish: "",
      season: "All",
      notes: "",
      image_url: "https://127.0.0.1/nope.jpg",
      source_url: ""
    }
  });
  assert.equal(res2.statusCode, 201);
  const body2 = res2.json() as { image_url: string };
  assert.equal(body2.image_url, "");
  cleanupCocktail(name);
  cleanupCocktail(name2);
});

test("UI: Find photo eligibility and messages", () => {
  assert.equal(canFindCocktailPhoto(true, ""), true);
  assert.equal(canFindCocktailPhoto(true, "   "), true);
  assert.equal(canFindCocktailPhoto(true, "/api/media/images/x.jpg"), false);
  assert.equal(canFindCocktailPhoto(false, ""), false);
  assert.equal(cocktailImageDiscoveryMessage("updated"), "Photo added");
  assert.equal(cocktailImageDiscoveryMessage("no_result"), "No trustworthy photo found");
  assert.equal(cocktailImageDiscoveryMessage("error"), "Could not search for a photo");
});

test("UI source: Keeper Find photo only when image missing; cards render image_url", () => {
  const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
  const cardSrc = readFileSync(join(root, "client/src/CocktailCard.tsx"), "utf8");
  assert.match(appSrc, /canFindCocktailPhoto/);
  assert.match(appSrc, /Find photo/);
  assert.match(appSrc, /\/cocktails\/\$\{drink\.id\}\/find-image/);
  assert.match(cardSrc, /imageUrl \? <img src=\{imageUrl\}/);
  assert.match(appSrc, /recipe-hero/);
  assert.match(appSrc, /alt=\{drink\.name\}/);
  // Guest path: showFindPhoto gates on admin via canFindCocktailPhoto
  assert.match(appSrc, /showFindPhoto &&/);
  const cssSrc = readFileSync(join(root, "client/src/cocktail-card.css"), "utf8");
  assert.match(cssSrc, /\.cocktail-card-media img\{[^}]*object-fit:cover/);
});
