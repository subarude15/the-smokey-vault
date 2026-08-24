import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSharedRecipeUrl } from "./recipe_share.js";

test("extractSharedRecipeUrl prefers the url field, then a link inside text", () => {
  assert.equal(
    extractSharedRecipeUrl({ url: "https://punchdrink.com/recipes/paper-plane/" }),
    "https://punchdrink.com/recipes/paper-plane/"
  );
  assert.equal(
    extractSharedRecipeUrl({
      title: "Paper Plane",
      text: "Paper Plane https://punchdrink.com/recipes/paper-plane/"
    }),
    "https://punchdrink.com/recipes/paper-plane/"
  );
  assert.equal(
    extractSharedRecipeUrl({ text: "See https://liquor.com/recipes/last-word/." }),
    "https://liquor.com/recipes/last-word/"
  );
  assert.equal(extractSharedRecipeUrl({ text: "no link here" }), "");
  assert.equal(extractSharedRecipeUrl({ url: "ftp://example.com/x" }), "");
});
