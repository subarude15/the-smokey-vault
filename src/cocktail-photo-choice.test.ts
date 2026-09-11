import assert from "node:assert/strict";
import { test } from "node:test";
process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { previewCocktailImages, resolveCocktailImageSelection } = await import("./cocktail_image.js");
const { app, createTestAdminToken } = await import("./server.js");
const { db } = await import("./db.js");
const { saveImageBuffer } = await import("./images.js");

test("preview preserves saved photo, deduplicates, caps choices and reuses bounded search", async () => {
  let searches = 0;
  const row = { id: 1, name: "French 75", image_url: "/api/media/images/current.jpg" };
  const result = await previewCocktailImages(row, {
    searchWebHits: async () => {
      searches++;
      return Array.from({ length: 8 }, (_, i) => ({ title: "French 75", content: "recipe", url: `https://www.liquor.com/recipe-${i}` }));
    },
    fetchHtml: async url => ({ finalUrl: url, html: `<h1>French 75</h1><meta property="og:image" content="${url}.jpg">` }),
    localizeImage: async url => {
      const n = Number(String(url).match(/recipe-(\d+)/)?.[1]);
      return n === 0 ? row.image_url : `/api/media/images/choice-${Math.floor(n / 2)}.jpg`;
    }
  });
  assert.equal(result.candidates.length, 3);
  assert.ok(searches <= 3);
  assert.equal(row.image_url, "/api/media/images/current.jpg");
});

test("pasted URL selections localize through shared media and empty removes", async () => {
  let requested = "";
  const local = await resolveCocktailImageSelection(" https://publisher.example/photo.jpg ", async url => {
    requested = url;
    return "/api/media/images/localized.jpg";
  });
  assert.equal(requested, "https://publisher.example/photo.jpg");
  assert.equal(local, "/api/media/images/localized.jpg");
  assert.equal(await resolveCocktailImageSelection("", async () => { throw new Error("unused"); }), "");
});

test("photo mutation is Keeper-only, validates media and protects concurrent edits", async () => {
  const name = "photo-choice-route-test";
  db.prepare("DELETE FROM cocktails WHERE name=?").run(name);
  const id = Number(db.prepare("INSERT INTO cocktails(name, ingredients, collection, image_url) VALUES (?, '[]', 'Custom Cocktails', ?)").run(name, "/api/media/images/original.jpg").lastInsertRowid);
  const headers = { authorization: `Bearer ${createTestAdminToken()}` };
  try {
    for (const [method, suffix] of [["POST", "image-options"], ["PUT", "image"]] as const) {
      assert.equal((await app.inject({ method, url: `/api/cocktails/${id}/${suffix}`, payload: {} })).statusCode, 401);
    }
    const url = `/api/cocktails/${id}/image`;
    for (const image_url of ["/api/media/images/../secret.jpg", "/api/media/images/missing-file.jpg"]) {
      assert.equal((await app.inject({ method: "PUT", url, headers, payload: { image_url, expected_image_url: "/api/media/images/original.jpg" } })).statusCode, 400);
    }
    const remove = await app.inject({ method: "PUT", url, headers, payload: { image_url: "", expected_image_url: "/api/media/images/original.jpg" } });
    assert.equal(remove.statusCode, 200);
    assert.equal((db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(id) as any).image_url, "");
    const image = saveImageBuffer(Buffer.from("photo-choice-test"), "image/png");
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { image_url: image, expected_image_url: "stale" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { image_url: image, expected_image_url: "" } })).statusCode, 200);
    assert.equal((db.prepare("SELECT image_url FROM cocktails WHERE id=?").get(id) as any).image_url, image);
  } finally { db.prepare("DELETE FROM cocktails WHERE id=?").run(id); }
});


test("Guests can view full photos; replacement controls belong to Keepers", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CocktailPhoto } = await import("../client/src/CocktailPhoto.js");
  const props = { id: 1, name: "French 75", imageUrl: "/api/media/images/test.jpg", onSaved() {} };
  const guest = renderToStaticMarkup(createElement(CocktailPhoto, { ...props, admin: false }));
  assert.match(guest, /View full photo of French 75/);
  assert.doesNotMatch(guest, /Replace photo|Choose photo|Find alternatives/);
  const keeper = renderToStaticMarkup(createElement(CocktailPhoto, { ...props, admin: true }));
  assert.match(keeper, /Replace photo/);
});
