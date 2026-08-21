import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeHttpUrl, isPrivateIp, parseRecipeHtml, RecipeImportError } from "./recipe_import.js";

test("private IPs and localhost links are rejected", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.4"), true);
  assert.equal(isPrivateIp("192.168.1.9"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.throws(() => assertSafeHttpUrl("http://localhost/recipe"), RecipeImportError);
  assert.throws(() => assertSafeHttpUrl("http://127.0.0.1/recipe"), RecipeImportError);
  assert.throws(() => assertSafeHttpUrl("file:///etc/passwd"), RecipeImportError);
  const ok = assertSafeHttpUrl("https://punchdrink.com/recipes/paper-plane/");
  assert.equal(ok.hostname, "punchdrink.com");
});

test("JSON-LD Recipe and og:image are read from a page", () => {
  const html = `
    <meta property="og:image" content="/images/plane.jpg">
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [{
          "@type": "Recipe",
          name: "Paper Plane",
          description: "Equal parts bourbon and amaro.",
          image: { url: "https://cdn.example/plane.jpg" },
          recipeIngredient: ["22 ml bourbon", "22 ml Aperol", "22 ml Amaro Nonino", "22 ml lemon juice"],
          recipeInstructions: [
            { "@type": "HowToStep", text: "Shake with ice." },
            { "@type": "HowToStep", text: "Strain into a coupe." }
          ]
        }]
      })}
    </script>`;
  const recipe = parseRecipeHtml(html, "https://punchdrink.com/recipes/paper-plane/");
  assert.equal(recipe.name, "Paper Plane");
  assert.equal(recipe.ingredients.length, 4);
  assert.match(recipe.method, /Shake with ice/);
  assert.equal(recipe.image_url, "https://cdn.example/plane.jpg");
  assert.equal(recipe.source_url, "https://punchdrink.com/recipes/paper-plane/");
});

test("relative og:image is resolved when JSON-LD has no photo", () => {
  const html = `
    <meta property="og:image" content="/hero.png">
    <script type="application/ld+json">
      {"@type":"Recipe","name":"Gimlet","recipeIngredient":["60 ml gin","30 ml lime cordial"]}
    </script>`;
  const recipe = parseRecipeHtml(html, "https://example.com/gimlet");
  assert.equal(recipe.image_url, "https://example.com/hero.png");
});

test("pages without ingredients fail clearly", () => {
  assert.throws(
    () => parseRecipeHtml("<html><title>Blog</title><p>No recipe here</p></html>", "https://example.com"),
    /ingredient list/i
  );
});
