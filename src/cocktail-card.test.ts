import assert from "node:assert/strict";
import test from "node:test";
import {
  cocktailReadinessPresentation,
  missingIngredientSummary,
  temporaryCocktailLabel
} from "../client/src/cocktail-card.ts";

test("cocktail card readiness preserves matcher semantics", () => {
  assert.deepEqual(cocktailReadinessPresentation("ready"), { label: "Ready", tone: "ready" });
  assert.deepEqual(cocktailReadinessPresentation("almost"), { label: "One bottle away", tone: "almost" });
  assert.deepEqual(cocktailReadinessPresentation("missing"), { label: "Missing ingredients", tone: "missing" });
});

test("cocktail card missing summary is deterministic and compact", () => {
  assert.equal(missingIngredientSummary([]), "");
  assert.equal(missingIngredientSummary(["Campari"]), "Missing: Campari");
  assert.equal(
    missingIngredientSummary(["Campari", "Sweet Vermouth", "Orange bitters"]),
    "Missing: Campari, Sweet Vermouth +1"
  );
});

test("temporary cocktail label is relative and hidden for permanent rows", () => {
  assert.equal(temporaryCocktailLabel(null), null);
  assert.equal(temporaryCocktailLabel(""), null);
  const soon = new Date(Date.now() + 18 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  assert.equal(temporaryCocktailLabel(soon), "TEMPORARY · EXPIRES IN 18H");
});
