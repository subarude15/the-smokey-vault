import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCocktailSteps,
  cocktailMethodSummary,
  parseCocktailInstructions,
  resolveCocktailInstructions
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

/* ---------------------- PR145: generated built-in steps -------------------- */

test("resolveCocktailInstructions keeps AI/custom full steps as-is (not generated)", () => {
  const resolved = resolveCocktailInstructions({
    method: "1. Add gin and lemon to a shaker with ice. 2. Shake. 3. Strain into a coupe.",
    glassware: "Coupe"
  });
  assert.equal(resolved.kind, "steps");
  if (resolved.kind !== "steps") return;
  assert.equal(resolved.generated, false, "existing structured steps are not replaced");
  assert.equal(resolved.steps.length, 3);
});

test("resolveCocktailInstructions keeps existing prose instructions", () => {
  const text = "Shake with ice. Strain into a chilled coupe and garnish with a lemon twist.";
  const resolved = resolveCocktailInstructions({ method: text, glassware: "Coupe" });
  assert.deepEqual(resolved, { kind: "prose", text });
});

test("a bare method label becomes real generated steps with the label kept as metadata", () => {
  const resolved = resolveCocktailInstructions({
    method: "Stir",
    glassware: "Rocks",
    garnish: "Orange twist",
    ingredients: ["45 ml bourbon", "1 sugar cube", "2 dashes bitters"]
  });
  assert.equal(resolved.kind, "steps");
  if (resolved.kind !== "steps") return;
  assert.equal(resolved.generated, true);
  assert.equal(resolved.methodLabel, "Stir", "short method preserved as metadata");
  assert.ok(resolved.steps.length >= 3, "renders real steps, not a bare label");
  // The steps must not simply be the method label.
  assert.ok(!resolved.steps.some((step) => step.trim() === "Stir"));
  assert.match(resolved.steps.join(" "), /mixing glass/i);
  assert.match(resolved.steps[resolved.steps.length - 1], /orange twist/i);
});

test("buildCocktailSteps is method-aware and always practical", () => {
  const shake = buildCocktailSteps({ method: "Shake", glassware: "Coupe", garnish: "Cherry" });
  assert.match(shake[0], /shaker/i);
  assert.match(shake.join(" "), /strain into a chilled coupe/i);

  const build = buildCocktailSteps({ method: "Build", glassware: "Highball", garnish: "Lime" });
  assert.match(build[0], /fill a highball glass with ice/i);

  const shakeTop = buildCocktailSteps({ method: "Shake and top", glassware: "Collins" });
  assert.match(shakeTop.join(" "), /non-sparkling/i);
  assert.match(shakeTop.join(" "), /top with the sparkling/i);

  const muddle = buildCocktailSteps({ method: "Muddle and build", glassware: "Julep", garnish: "Mint" });
  assert.match(muddle[0], /muddle/i);

  // Hot builds must not tell you to fill with ice.
  const hot = buildCocktailSteps({ method: "Build", glassware: "Mug", ingredients: ["45 ml whiskey", "hot water"] });
  assert.doesNotMatch(hot.join(" "), /with ice/i);
  assert.match(hot.join(" "), /warmed mug|serve hot/i);
});

test("empty method still yields generic practical steps (never a blank recipe)", () => {
  const resolved = resolveCocktailInstructions({ method: "", glassware: "Rocks", garnish: "Lime" });
  assert.equal(resolved.kind, "steps");
  if (resolved.kind !== "steps") return;
  assert.equal(resolved.generated, true);
  assert.equal(resolved.methodLabel, null);
  assert.ok(resolved.steps.length >= 3);
});
