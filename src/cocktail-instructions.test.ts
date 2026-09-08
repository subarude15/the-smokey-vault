import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCocktailSteps,
  cocktailMethodSummary,
  isCocktailMethodLabel,
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

test("short instructional prose is preserved, never mistaken for a bare label", () => {
  // These start with a technique word but are real instructions — they must NOT be regenerated.
  const proseSamples = [
    "Shake with ice and strain into a coupe.",
    "Stir over ice until chilled, then strain.",
    "Build over ice and top with soda.",
    "Muddle the mint, then build over crushed ice."
  ];
  for (const text of proseSamples) {
    assert.equal(isCocktailMethodLabel(text), false, `${text} is prose, not a label`);
    const resolved = resolveCocktailInstructions({ method: text, glassware: "Coupe" });
    assert.deepEqual(resolved, { kind: "prose", text }, `${text} preserved verbatim`);
  }
});

test("coffee LIQUEUR does not make a Build cocktail hot (cold rocks-glass build)", () => {
  const isCold = (ingredients: string[]) => {
    const steps = buildCocktailSteps({ method: "Build", glassware: "Rocks", ingredients }).join(" ");
    assert.match(steps, /fill a rocks glass with ice/i, `expected iced build for ${ingredients.join(", ")}`);
    assert.doesNotMatch(steps, /warmed|serve hot/i, `must not be a hot build for ${ingredients.join(", ")}`);
  };
  // coffee liqueur alone
  isCold(["20 ml coffee liqueur"]);
  // Kahlúa / coffee liqueur phrasing
  isCold(["20 ml Kahlúa coffee liqueur"]);
  isCold(["20 ml Kahlúa"]);
  // White Russian ingredients
  isCold(["50 ml vodka", "20 ml coffee liqueur", "30 ml cream"]);
  // Black Russian ingredients
  isCold(["50 ml vodka", "20 ml coffee liqueur"]);
});

test("up-served glasses (flute/coupe/martini) never get ice in the serving glass", () => {
  const noIce = (steps: string[], label: string) => {
    const joined = steps.join(" ");
    // Ice in the shaker is fine; the serving glass must not be iced.
    assert.doesNotMatch(joined, /over fresh ice/i, `${label} must not strain over ice: ${joined}`);
    assert.doesNotMatch(joined, /fill a [\w ]*with ice/i, `${label} must not fill the glass with ice: ${joined}`);
    assert.match(joined, /chilled/i, `${label} should use a chilled glass`);
  };
  // French 75 — Shake and top into a flute (no ice).
  noIce(buildCocktailSteps({ method: "Shake and top", glassware: "Flute", garnish: "Lemon twist" }), "French 75");
  // Mimosa — Build into a flute (no ice).
  noIce(buildCocktailSteps({ method: "Build", glassware: "Flute" }), "Mimosa");
  // Champagne Cocktail — Build into a flute (no ice).
  noIce(buildCocktailSteps({ method: "Build", glassware: "Flute", garnish: "Lemon twist" }), "Champagne Cocktail");
  // Empty method into a coupe (generic) — still no ice.
  noIce(buildCocktailSteps({ method: "", glassware: "Coupe" }), "generic coupe");
});

test("iced glasses (highball/rocks) still get ice for Build and Shake-and-top", () => {
  const mule = buildCocktailSteps({ method: "Build", glassware: "Mug", garnish: "Lime", ingredients: ["45 ml vodka", "ginger beer"] }).join(" ");
  assert.match(mule, /fill a mug with ice/i);
  const collins = buildCocktailSteps({ method: "Shake and top", glassware: "Highball" }).join(" ");
  assert.match(collins, /over fresh ice/i);
});

test("genuine hot beverages still produce a hot Build", () => {
  const isHot = (ingredients: string[]) => {
    const steps = buildCocktailSteps({ method: "Build", glassware: "Mug", ingredients }).join(" ");
    assert.match(steps, /warmed mug|serve hot/i, `expected hot build for ${ingredients.join(", ")}`);
    assert.doesNotMatch(steps, /with ice/i, `hot build must not add ice for ${ingredients.join(", ")}`);
  };
  isHot(["45 ml whiskey", "hot water"]);
  isHot(["45 ml rum", "hot coffee"]);
  // Real coffee as the beverage (Irish Coffee style)
  isHot(["50 ml Irish whiskey", "120 ml coffee", "50 ml cream", "1 tsp sugar"]);
  isHot(["45 ml whiskey", "brewed coffee"]);
  isHot(["45 ml rum", "hot tea"]);
  isHot(["45 ml bourbon", "hot milk"]);
  isHot(["45 ml rum", "boiling water"]);
});

test("genuine technique labels are recognized regardless of case/trailing period", () => {
  for (const label of ["Build", "Shake", "Stir", "Shake and top", "Shake hard and top", "Muddle and build"]) {
    assert.equal(isCocktailMethodLabel(label), true, `${label} is a technique label`);
  }
  assert.equal(isCocktailMethodLabel("stir."), true, "trailing period tolerated");
  assert.equal(isCocktailMethodLabel("SHAKE"), true, "case-insensitive");
  // Not real techniques → treated as prose.
  assert.equal(isCocktailMethodLabel("Serve immediately"), false);
  assert.equal(isCocktailMethodLabel("Combine and enjoy"), false);
});
