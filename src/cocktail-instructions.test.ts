import assert from "node:assert/strict";
import test from "node:test";
import {
  cocktailMethodSummary,
  parseCocktailInstructions
} from "../client/src/cocktail-instructions.ts";

test("numbered steps stay ordered and lossless", () => {
  const parsed = parseCocktailInstructions(
    "1. Add gin, lemon juice, and syrup to a shaker with ice. 2. Shake until chilled. 3. Add sparkling wine to the glass. 4. Strain the shaken mixture into the glass. 5. Garnish with a lemon twist."
  );
  assert.equal(parsed.kind, "steps");
  if (parsed.kind !== "steps") return;
  assert.deepEqual(parsed.steps, [
    "Add gin, lemon juice, and syrup to a shaker with ice.",
    "Shake until chilled.",
    "Add sparkling wine to the glass.",
    "Strain the shaken mixture into the glass.",
    "Garnish with a lemon twist."
  ]);
});

test("newline-delimited steps preserve order", () => {
  const parsed = parseCocktailInstructions(
    "Add gin and lemon to a shaker with ice.\nShake until chilled.\nStrain into a flute and top with sparkling wine."
  );
  assert.equal(parsed.kind, "steps");
  if (parsed.kind !== "steps") return;
  assert.deepEqual(parsed.steps, [
    "Add gin and lemon to a shaker with ice.",
    "Shake until chilled.",
    "Strain into a flute and top with sparkling wine."
  ]);
});

test("single prose instruction is not fragmented", () => {
  const text = "Shake with ice. Strain into a chilled coupe and garnish with a lemon twist.";
  const parsed = parseCocktailInstructions(text);
  assert.deepEqual(parsed, { kind: "prose", text });
});

test("generic method fallback still works", () => {
  assert.deepEqual(parseCocktailInstructions("Shake"), { kind: "method", label: "Shake" });
  assert.deepEqual(parseCocktailInstructions("Shake and top"), { kind: "method", label: "Shake and top" });
  assert.deepEqual(parseCocktailInstructions("Muddle and build"), { kind: "method", label: "Muddle and build" });
  assert.equal(cocktailMethodSummary("Stir"), "Stir");
  assert.equal(cocktailMethodSummary("1. Shake.\n2. Strain."), "");
});

test("empty instruction data does not create fake steps", () => {
  assert.deepEqual(parseCocktailInstructions(""), { kind: "empty" });
  assert.deepEqual(parseCocktailInstructions("   "), { kind: "empty" });
  assert.deepEqual(parseCocktailInstructions(null), { kind: "empty" });
  assert.deepEqual(parseCocktailInstructions(undefined), { kind: "empty" });
});
