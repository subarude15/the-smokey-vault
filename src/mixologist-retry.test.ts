/**
 * Phase 2 — Try another reuses the original request and asks for a different cocktail.
 * Generate-mode clients that only send { prompt } stay on the old path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AiRecipeParseError, parseGeneratedRecipe } from "./ai_recipe.js";
import {
  mixologistRequiredBottlePrompt,
  shelfBottleFromItem
} from "./cocktails.js";
import {
  mixologistGenerateRequest,
  mixologistLlmPrompt,
  mixologistRefineRequest,
  mixologistRetryRequest
} from "./mixologist_prompt.js";
import { db } from "./db.js";
import {
  emptyMixologistView,
  mixologistActionsLocked,
  mixologistGenerateBody,
  mixologistRefineBody,
  mixologistRetryBody,
  reduceMixologist,
  tryAnotherVisible,
  type MixologistRecipe
} from "../client/src/mixologist-retry.ts";

process.env.SMOKEY_TEST_NO_LISTEN = "1";
const { app } = await import("./server.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const previous: MixologistRecipe = {
  name: "Smoky Old Fashioned",
  ingredients: ["60 ml bourbon", "1 sugar cube"],
  method: "Stir over ice.",
  glassware: "Rocks",
  garnish: "Orange peel",
  season: "Fall",
  notes: "Short and smoky."
};
const next: MixologistRecipe = {
  ...previous,
  name: "Highball Shift",
  ingredients: ["45 ml tequila", "soda water"],
  method: "Build in the glass.",
  glassware: "Highball",
  garnish: "Lime wheel",
  season: "Summer",
  notes: "Longer and brighter."
};

function cocktailCount() {
  return (db.prepare("SELECT COUNT(*) AS n FROM cocktails").get() as { n: number }).n;
}

function mixologistRoute(): string {
  const server = readFileSync(join(root, "src/server.ts"), "utf8");
  const start = server.indexOf('"/api/ai/mixologist"');
  const end = server.indexOf('"/api/cocktails/import"');
  assert.ok(start >= 0 && end > start);
  return server.slice(start, end);
}

function mixologistPanel(): string {
  const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
  const start = appSrc.indexOf("function MixologistPanel(");
  const end = appSrc.indexOf("function lastBackupLabel(");
  assert.ok(start >= 0 && end > start);
  return appSrc.slice(start, end);
}

test("generate mode keeps the old prompt-only request", () => {
  assert.equal(mixologistGenerateRequest("Something refreshing and not too sweet.", null), "Something refreshing and not too sweet.");
  assert.equal(mixologistGenerateRequest(undefined, null), "Create a cocktail");
  assert.deepEqual(mixologistGenerateBody("Something spicy with tequila"), { prompt: "Something spicy with tequila" });
  const llm = mixologistLlmPrompt([{ name: "Rye", kind: "spirit" }], mixologistGenerateRequest("bright", null));
  assert.match(llm, /Shelf: \[\{"name":"Rye","kind":"spirit"\}\]/);
  assert.match(llm, /Request: bright/);
  assert.doesNotMatch(llm, /Previous suggestion/);
  assert.doesNotMatch(llm, /materially different/);
});

test("retry prompt includes the original request, the previous recipe, and a demand for a different drink", () => {
  const bottle = shelfBottleFromItem({
    name: "Bourbon",
    brand: "Buffalo Trace",
    category: "Whiskey",
    fill_level: 100,
    stock_count: 1
  }, "spirit");
  assert.equal(
    mixologistGenerateRequest("use Buffalo Trace", bottle),
    mixologistRequiredBottlePrompt(bottle, "use Buffalo Trace")
  );
  const request = mixologistRetryRequest("Something refreshing and not too sweet.", previous, bottle);
  assert.match(request, /Something refreshing and not too sweet/);
  assert.match(request, /Smoky Old Fashioned/);
  assert.match(request, /60 ml bourbon/);
  assert.match(request, /HARD REQUIREMENT/);
  assert.match(request, new RegExp(bottle.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(request, /materially different/);
  assert.match(request, /must not have the same name/);
  assert.match(request, /Do not merely rename the cocktail/);
  const llm = mixologistLlmPrompt([{ name: bottle.label, kind: "spirit" }], request);
  assert.match(llm, /Shelf:/);
  assert.match(llm, new RegExp(bottle.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(llm, /Prefer bottles actually on the shelf/);
});

test("refine prompt keeps the original request, the current recipe, and the latest change", () => {
  const bottle = shelfBottleFromItem({
    name: "Bourbon",
    brand: "Buffalo Trace",
    category: "Whiskey",
    fill_level: 100,
    stock_count: 1
  }, "spirit");
  const request = mixologistRefineRequest(
    "Something smoky and not too sweet.",
    previous,
    "I don't want rum. Make it vodka based instead.",
    bottle
  );
  assert.match(request, /Something smoky and not too sweet/);
  assert.match(request, /Smoky Old Fashioned/);
  assert.match(request, /60 ml bourbon/);
  assert.match(request, /I don't want rum\. Make it vodka based instead/);
  assert.match(request, /Current cocktail:/);
  assert.match(request, /User refinement:/);
  assert.match(request, /FULL revised recipe/);
  assert.match(request, /output format/);
  assert.match(request, /HARD REQUIREMENT/);
  assert.match(request, new RegExp(bottle.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const llm = mixologistLlmPrompt([{ name: bottle.label, kind: "spirit" }], request);
  assert.match(llm, /Shelf:/);
  assert.doesNotMatch(mixologistGenerateRequest("bright", null), /User refinement/);
  assert.doesNotMatch(mixologistRetryRequest("bright", previous), /User refinement/);
});

test("malformed retry model output still fails the existing recipe parser", () => {
  assert.throws(() => parseGeneratedRecipe("Here is a nice drink, not JSON."), (error: unknown) => {
    assert.ok(error instanceof AiRecipeParseError);
    return true;
  });
  const route = mixologistRoute();
  assert.match(route, /parseGeneratedRecipe\(result\)/);
  assert.match(route, /parseGeneratedRecipe\(retry\)/);
  assert.match(route, /mixologistShelfSummary\(currentShelf\(\)\)/);
  assert.match(route, /mixologistGenerateRequest/);
  assert.match(route, /mixologistRetryRequest/);
  assert.match(route, /mixologistRefineRequest/);
  assert.doesNotMatch(route, /INSERT|UPDATE|DELETE/);
});

test("retry mode rejects a missing prompt, a bad previous recipe, and an unknown mode without writing a cocktail", async () => {
  const before = cocktailCount();
  const missingPrevious = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "retry", prompt: "Something spicy with tequila" }
  });
  assert.equal(missingPrevious.statusCode, 400);
  const missingPrompt = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "retry", previous_recipe: previous }
  });
  assert.equal(missingPrompt.statusCode, 400);
  const malformed = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "retry", prompt: "Something spicy", previous_recipe: { name: "Only a name" } }
  });
  assert.equal(malformed.statusCode, 400);
  const unknown = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "chat", prompt: "make it less sweet" }
  });
  assert.equal(unknown.statusCode, 400);
  const missingRefinement = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "refine", prompt: "Something smoky", previous_recipe: previous }
  });
  assert.equal(missingRefinement.statusCode, 400);
  const blankRefinement = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "refine", prompt: "Something smoky", previous_recipe: previous, refinement: "   " }
  });
  assert.equal(blankRefinement.statusCode, 400);
  const badRefineRecipe = await app.inject({
    method: "POST",
    url: "/api/ai/mixologist",
    payload: { mode: "refine", prompt: "Something smoky", previous_recipe: { name: "Only a name" }, refinement: "Make it less sweet." }
  });
  assert.equal(badRefineRecipe.statusCode, 400);
  assert.equal(cocktailCount(), before);
});

test("Try another reuses the prompt that created the current recipe and replaces it only on success", () => {
  let view = reduceMixologist(emptyMixologistView(), { type: "edit", text: "Something spicy with tequila" });
  assert.equal(tryAnotherVisible(view), false);
  view = reduceMixologist(view, { type: "generate-start" });
  assert.equal(mixologistActionsLocked(view), true);
  assert.equal(view.recipe, undefined);
  view = reduceMixologist(view, { type: "success", recipe: previous, prompt: "Something spicy with tequila" });
  view = reduceMixologist(view, { type: "save-start" });
  view = reduceMixologist(view, { type: "save-success", saved: "guest" });
  view = reduceMixologist(view, { type: "edit", text: "a totally different sentence" });
  assert.equal(tryAnotherVisible(view), true);
  assert.equal(view.askedPrompt, "Something spicy with tequila");
  assert.equal(view.textarea, "a totally different sentence");
  const body = mixologistRetryBody(view.askedPrompt, view.recipe!);
  assert.equal(body.mode, "retry");
  assert.equal(body.prompt, "Something spicy with tequila");
  assert.equal(body.previous_recipe.name, "Smoky Old Fashioned");
  assert.deepEqual(body.previous_recipe.ingredients, previous.ingredients);

  view = reduceMixologist(view, { type: "retry-start" });
  assert.equal(mixologistActionsLocked(view), true);
  assert.equal(view.recipe?.name, "Smoky Old Fashioned");
  assert.equal(view.saved, "guest");
  view = reduceMixologist(view, { type: "failure", error: "The AI service could not be reached." });
  assert.equal(view.recipe?.name, "Smoky Old Fashioned");
  assert.equal(view.error, "The AI service could not be reached.");
  assert.equal(mixologistActionsLocked(view), false);

  view = reduceMixologist(view, { type: "retry-start" });
  view = reduceMixologist(view, { type: "success", recipe: next, prompt: view.askedPrompt });
  assert.equal(view.recipe?.name, "Highball Shift");
  assert.equal(view.saved, "");
  assert.equal(view.askedPrompt, "Something spicy with tequila");
});

test("a pending save locks retry and generation until it settles", () => {
  let view = reduceMixologist(emptyMixologistView(), { type: "success", recipe: previous, prompt: "Something spicy with tequila" });
  view = reduceMixologist(view, { type: "save-start" });
  assert.equal(mixologistActionsLocked(view), true);
  assert.equal(view.saving, true);
  assert.equal(reduceMixologist(view, { type: "retry-start" }), view);
  assert.equal(reduceMixologist(view, { type: "generate-start" }), view);
  assert.equal(reduceMixologist(view, { type: "save-start" }), view);
  assert.equal(view.recipe?.name, "Smoky Old Fashioned");

  const failed = reduceMixologist(view, { type: "save-failure", error: "Could not save the recipe." });
  assert.equal(mixologistActionsLocked(failed), false);
  assert.equal(failed.saving, false);
  assert.equal(failed.recipe?.name, "Smoky Old Fashioned");
  assert.equal(failed.error, "Could not save the recipe.");

  view = reduceMixologist(view, { type: "save-success", saved: "guest" });
  assert.equal(mixologistActionsLocked(view), false);
  assert.equal(view.saved, "guest");
  assert.equal(view.recipe?.name, "Smoky Old Fashioned");
  assert.equal(reduceMixologist(view, { type: "save-success", saved: "keeper" }), view);

  view = reduceMixologist(view, { type: "retry-start" });
  assert.equal(mixologistActionsLocked(view), true);
  assert.equal(reduceMixologist(view, { type: "save-start" }), view);
  assert.equal(reduceMixologist(view, { type: "refine-start" }), view);
});

test("MixologistPanel shows Try another only beside a recipe and locks both actions while loading", () => {
  const panel = mixologistPanel();
  assert.match(panel, /Try another/);
  assert.match(panel, /className="secondary"/);
  assert.match(panel, /run\(view\.askedPrompt, recipe\)/);
  assert.match(panel, /mixologistRetryBody/);
  assert.match(panel, /retry-start/);
  assert.match(panel, /generate-start/);
  assert.match(panel, /save-start/);
  assert.match(panel, /Saving…/);
  assert.match(panel, /disabled=\{locked \|\| saved !== ""\}/);
  assert.match(panel, /disabled=\{locked\}>Try another/);
  assert.match(panel, /name: recipe\.name/);
  assert.match(panel, /Trying another drink/);
  assert.match(panel, /Want to change it\?/);
  assert.match(panel, /Update drink/);
  assert.match(panel, /mixologistRefineBody/);
  assert.match(panel, /refine-start/);
  assert.match(panel, /run\(view\.askedPrompt, recipe, view\.refinementText\)/);
  assert.doesNotMatch(panel, /Message history/);
});

test("refinement revises the current drink and keeps the original request", () => {
  let view = reduceMixologist(emptyMixologistView(), { type: "success", recipe: previous, prompt: "Something smoky and not too sweet" });
  assert.equal(tryAnotherVisible(view), true);
  view = reduceMixologist(view, { type: "edit-refinement", text: "Make it less sweet." });
  view = reduceMixologist(view, { type: "save-start" });
  assert.equal(reduceMixologist(view, { type: "refine-start" }), view);
  view = reduceMixologist(view, { type: "save-success", saved: "guest" });
  assert.equal(view.saved, "guest");

  view = reduceMixologist(view, { type: "edit-refinement", text: "Make it less sweet." });
  const body = mixologistRefineBody(view.askedPrompt, view.recipe!, view.refinementText);
  assert.equal(body.mode, "refine");
  assert.equal(body.prompt, "Something smoky and not too sweet");
  assert.equal(body.refinement, "Make it less sweet.");
  assert.equal(body.previous_recipe.name, "Smoky Old Fashioned");

  view = reduceMixologist(view, { type: "refine-start" });
  assert.equal(mixologistActionsLocked(view), true);
  assert.equal(view.recipe?.name, "Smoky Old Fashioned");
  assert.equal(view.refinementText, "Make it less sweet.");
  assert.equal(reduceMixologist(view, { type: "retry-start" }), view);
  assert.equal(reduceMixologist(view, { type: "generate-start" }), view);
  assert.equal(reduceMixologist(view, { type: "save-start" }), view);

  const failed = reduceMixologist(view, { type: "failure", error: "The AI service could not be reached." });
  assert.equal(failed.recipe?.name, "Smoky Old Fashioned");
  assert.equal(failed.refinementText, "Make it less sweet.");
  assert.equal(failed.askedPrompt, "Something smoky and not too sweet");
  assert.equal(mixologistActionsLocked(failed), false);

  view = reduceMixologist(failed, { type: "refine-start" });
  view = reduceMixologist(view, { type: "success", recipe: next, prompt: view.askedPrompt });
  assert.equal(view.recipe?.name, "Highball Shift");
  assert.equal(view.askedPrompt, "Something smoky and not too sweet");
  assert.equal(view.saved, "");
  assert.equal(view.refinementText, "");
  const retry = mixologistRetryBody(view.askedPrompt, view.recipe!);
  assert.equal(retry.previous_recipe.name, "Highball Shift");
  assert.equal(retry.prompt, "Something smoky and not too sweet");
});
