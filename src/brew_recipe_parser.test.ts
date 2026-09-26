import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { db } from "./db.js";
import { brewRecipeDocumentSchema } from "./brew_sheets.js";
import {
  BREW_RECIPE_PARSE_MAX_CHARS,
  BREW_RECIPE_PARSE_MAX_TOKENS,
  BrewRecipeParseError,
  brewRecipeParseStatus,
  parseBrewRecipeFromText,
  type BrewRecipeAiCaller
} from "./brew_recipe_parser.js";

const CANDY_CLOUD_TEXT = `Smokey Barrel Brewery • Brew Sheet
Candy Cloud Hazy DIPA (Stash-Buster Edition)
System: SS Brewtech V3 3-Kettle Electric | Fermenter: 7-Gal Unitank | Target Yield: 6.0 Gal

Target OG: ~1.080
Target FG: 1.020 – 1.022
Estimated ABV: ~7.8%
Bitterness: ~25 IBU
Mash Efficiency: 72%
Boil: 60 min

1. Water Chemistry & Additions
Start with roughly 10.0 Gallons of 100% Reverse Osmosis (RO) water.
Strike Water: 5.50 Gallons
Sparge Water: ~4.50 Gallons
Target Mash pH: 5.20 – 5.35
Chloride: 200–225 ppm
Sulfate: 50–65 ppm
Calcium: 100–120 ppm

2. Grist & Fermentables
2-Row Pale Malt 11.50 lbs
Flaked Oats 4.00 lbs
Flaked Wheat 3.00 lbs
Carapils 1.00 lb
Rice Hulls 1.00 lb
Maltodextrin 8 oz

3. Boil
Citra 1.00 oz at 60 min
Do not add Whirlfloc or Irish Moss.

4. Whirlpool
Mosaic LUPOMAX 2.00 oz at 170°F for 20 min

5. Fermentation
Yeast: London Fog III
Day 1: ferment at 68°F
Day 3: raise to 72°F when gravity reaches 1.030

6. Dry Hop
DH #1 Day 2: Citra LUPOMAX 1.5 oz
DH #2 Day 5: Mosaic 2.0 oz at 68°F

7. Packaging
Oxygen-free transfer to keg.
Add ALDC at packaging, not during the boil.

Checklist:
- Confirm mash pH before sparge
- Oxygen-free transfer`;

const candyDocument = {
  beerName: "Candy Cloud Hazy DIPA",
  style: "Hazy DIPA",
  system: "SS Brewtech V3 3-Kettle Electric",
  fermenter: "7-Gal Unitank",
  targetPackaged: "6.0 Gal",
  fermenterVolume: "",
  boilTime: "60 min",
  targetOg: "1.080",
  targetFg: "1.020 – 1.022",
  targetAbv: "~7.8%",
  estimatedIbu: "25",
  mashEfficiency: "72%",
  water: {
    source: "100% Reverse Osmosis (RO)",
    strikeWater: "5.50 Gallons",
    spargeWater: "~4.50 Gallons",
    targetMashPh: "5.20 – 5.35",
    chloridePpm: "200–225 ppm",
    sulfatePpm: "50–65 ppm",
    calciumPpm: "100–120 ppm"
  },
  fermentables: [
    { ingredient: "2-Row Pale Malt", amount: "11.50 lbs" },
    { ingredient: "Flaked Oats", amount: "4.00 lbs" },
    { ingredient: "Flaked Wheat", amount: "3.00 lbs" },
    { ingredient: "Carapils", amount: "1.00 lb" },
    { ingredient: "Rice Hulls", amount: "1.00 lb" },
    { ingredient: "Maltodextrin", amount: "8 oz" }
  ],
  kettleAdditions: [{ ingredient: "Citra", amount: "1.00 oz", time: "60 min" }],
  whirlpoolAdditions: [{ ingredient: "Mosaic LUPOMAX", amount: "2.00 oz", temperature: "170°F", time: "20 min" }],
  dryHopStages: [
    { stage: "DH #1", variety: "Citra LUPOMAX", amount: "1.5 oz", when: "Day 2" },
    { stage: "DH #2", variety: "Mosaic", amount: "2.0 oz", when: "Day 5", temperature: "68°F" }
  ],
  fermentation: {
    yeast: "London Fog III",
    steps: [
      { when: "Day 1", temperature: "68°F", action: "ferment" },
      { when: "Day 3", gravity: "1.030", temperature: "72°F", action: "raise temperature" }
    ]
  },
  packaging: {
    steps: ["Oxygen-free transfer to keg", "Add ALDC at packaging"]
  },
  warnings: [
    "Do not add Whirlfloc or Irish Moss",
    "Oxygen-free transfer",
    "Add ALDC at packaging, not during the boil"
  ],
  checklist: ["Confirm mash pH before sparge", "Oxygen-free transfer"],
  notes: "Stash-Buster Edition"
};

function recipeCount() {
  return (db.prepare("SELECT COUNT(*) AS n FROM brew_recipes").get() as { n: number }).n;
}

function sessionCount() {
  return (db.prepare("SELECT COUNT(*) AS n FROM brew_sessions").get() as { n: number }).n;
}

test("parseBrewRecipeFromText accepts a Candy Cloud-like recipe and does not save it", async () => {
  const recipesBefore = recipeCount();
  const sessionsBefore = sessionCount();
  let prompt = "";
  const recipe = await parseBrewRecipeFromText(CANDY_CLOUD_TEXT, async (next) => {
    prompt = next;
    return JSON.stringify(candyDocument);
  });

  assert.deepEqual(recipe, brewRecipeDocumentSchema.parse(candyDocument));
  assert.equal(recipe.beerName, "Candy Cloud Hazy DIPA");
  assert.equal(recipe.kettleAdditions.length, 1);
  assert.equal(recipe.whirlpoolAdditions.length, 1);
  assert.equal(recipe.dryHopStages.length, 2);
  assert.equal(recipe.warnings[0], "Do not add Whirlfloc or Irish Moss");
  assert.match(prompt, /Candy Cloud Hazy DIPA/);
  assert.match(prompt, /Citra LUPOMAX/);
  assert.match(prompt, /Do not invent missing brewing values/);
  assert.match(prompt, /Do not calculate values that are not explicitly supplied/);
  assert.match(prompt, /Do not invent salt weights/);
  assert.match(prompt, /deterministic water-chemistry module/);
  assert.match(prompt, /sodiumPpm/);
  assert.match(prompt, /magnesiumPpm/);
  assert.match(prompt, /totalWater/);
  assert.match(prompt, /Return only a JSON object/);
  assert.match(prompt, /kettleAdditions/);
  assert.match(prompt, /whirlpoolAdditions/);
  assert.match(prompt, /dryHopStages/);
  assert.doesNotMatch(prompt, /@page|stylesheet|brew-sheet template/i);
  assert.equal(recipeCount(), recipesBefore);
  assert.equal(sessionCount(), sessionsBefore);
});

test("malformed AI output is rejected without echoing the provider text", async () => {
  const secret = "sk-parser-should-not-echo";
  await assert.rejects(
    () => parseBrewRecipeFromText(CANDY_CLOUD_TEXT, async () => `not json ${secret}`),
    (error: unknown) => {
      assert.ok(error instanceof BrewRecipeParseError);
      assert.equal(error.code, "malformed");
      assert.equal(brewRecipeParseStatus(error), 502);
      assert.equal(error.message, "The AI could not parse this brewing recipe");
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test("a single json fence is stripped before schema validation", async () => {
  const recipe = await parseBrewRecipeFromText(
    CANDY_CLOUD_TEXT,
    async () => `\`\`\`json\n${JSON.stringify(candyDocument)}\n\`\`\``
  );
  assert.equal(recipe.beerName, "Candy Cloud Hazy DIPA");
  assert.equal((recipe.dryHopStages[0] as { variety: string }).variety, "Citra LUPOMAX");
});

test("prose around a json fence is not repaired", async () => {
  await assert.rejects(
    () => parseBrewRecipeFromText(
      CANDY_CLOUD_TEXT,
      async () => `Here is the recipe:\n\`\`\`json\n${JSON.stringify(candyDocument)}\n\`\`\``
    ),
    (error: unknown) => {
      assert.ok(error instanceof BrewRecipeParseError);
      assert.equal(error.code, "malformed");
      return true;
    }
  );
});

test("schema-invalid AI output is rejected", async () => {
  await assert.rejects(
    () => parseBrewRecipeFromText(
      CANDY_CLOUD_TEXT,
      async () => JSON.stringify({ beerName: "Candy Cloud Hazy DIPA", targetOg: 1.08, warnings: "Do not add Whirlfloc" })
    ),
    (error: unknown) => {
      assert.ok(error instanceof BrewRecipeParseError);
      assert.equal(error.code, "invalid");
      assert.equal(brewRecipeParseStatus(error), 502);
      assert.equal(error.message, "The AI could not parse this brewing recipe");
      return true;
    }
  );
});

test("empty brewing instructions are rejected before the AI caller", async () => {
  let calls = 0;
  const complete: BrewRecipeAiCaller = async () => {
    calls += 1;
    return JSON.stringify(candyDocument);
  };
  for (const text of ["", "   \n\t  "]) {
    await assert.rejects(
      () => parseBrewRecipeFromText(text, complete),
      (error: unknown) => {
        assert.ok(error instanceof BrewRecipeParseError);
        assert.equal(error.code, "empty");
        assert.equal(error.message, "Brewing instructions are required");
        assert.equal(brewRecipeParseStatus(error), 400);
        return true;
      }
    );
  }
  await assert.rejects(
    () => parseBrewRecipeFromText("x".repeat(BREW_RECIPE_PARSE_MAX_CHARS + 1), complete),
    (error: unknown) => {
      assert.ok(error instanceof BrewRecipeParseError);
      assert.equal(error.code, "too_long");
      assert.equal(error.message, "Brewing instructions are too long");
      return true;
    }
  );
  assert.equal(calls, 0);
});

const AI_ENV_KEYS = [
  "AI_PROVIDER",
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OLLAMA_HOST"
] as const;

describe("POST /api/admin/brewery/parse-recipe", { concurrency: false }, () => {
  test("requires a keeper session, rejects empty text, does not save, and hides provider errors", async () => {
    const { app, createTestAdminToken } = await import("./server.js");
    const token = createTestAdminToken();
    const recipesBefore = recipeCount();
    const sessionsBefore = sessionCount();
    const savedEnv = Object.fromEntries(AI_ENV_KEYS.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    const restore = () => {
      globalThis.fetch = originalFetch;
      for (const key of AI_ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    };

    const installFetch = (status: number, payload: unknown) => {
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        assert.equal(String(url), "https://ai.example.test/v1/chat/completions");
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.authorization, "Bearer test-key-not-real");
        const body = JSON.parse(String(init?.body)) as {
          max_tokens?: number;
          messages?: Array<{ content?: string }>;
        };
        assert.equal(body.max_tokens, BREW_RECIPE_PARSE_MAX_TOKENS);
        assert.match(body.messages?.[0]?.content ?? "", /Candy Cloud Hazy DIPA/);
        assert.match(body.messages?.[0]?.content ?? "", /Do not invent missing brewing values/);
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch;
    };

    try {
      for (const key of AI_ENV_KEYS) delete process.env[key];
      process.env.AI_PROVIDER = "openai";
      process.env.AI_API_KEY = "test-key-not-real";
      process.env.AI_BASE_URL = "https://ai.example.test/v1";
      process.env.AI_MODEL = "gpt-test";
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run before a valid keeper parse");
      }) as typeof fetch;

      const anonymous = await app.inject({
        method: "POST",
        url: "/api/admin/brewery/parse-recipe",
        payload: { text: CANDY_CLOUD_TEXT }
      });
      assert.equal(anonymous.statusCode, 401);
      assert.deepEqual(anonymous.json(), { error: "Admin session required" });

      const forged = await app.inject({
        method: "POST",
        url: "/api/admin/brewery/parse-recipe",
        headers: { authorization: "Bearer not-a-keeper" },
        payload: { text: CANDY_CLOUD_TEXT }
      });
      assert.equal(forged.statusCode, 401);
      assert.equal(fetchCalls, 0);

      const empty = await app.inject({
        method: "POST",
        url: "/api/admin/brewery/parse-recipe",
        headers: { authorization: `Bearer ${token}` },
        payload: { text: "  \n" }
      });
      assert.equal(empty.statusCode, 400);
      assert.deepEqual(empty.json(), { error: "Brewing instructions are required" });
      assert.equal(fetchCalls, 0);

      installFetch(200, { choices: [{ message: { content: JSON.stringify(candyDocument) } }] });
      const parsed = await app.inject({
        method: "POST",
        url: "/api/admin/brewery/parse-recipe",
        headers: { authorization: `Bearer ${token}` },
        payload: { text: CANDY_CLOUD_TEXT }
      });
      assert.equal(parsed.statusCode, 200);
      const body = parsed.json() as { recipe: { beerName?: string; id?: number; sourceText?: string } };
      assert.equal(body.recipe.beerName, "Candy Cloud Hazy DIPA");
      assert.equal(body.recipe.id, undefined);
      assert.equal(body.recipe.sourceText, undefined);
      assert.equal(parsed.body.includes("test-key-not-real"), false);
      assert.equal(recipeCount(), recipesBefore);
      assert.equal(sessionCount(), sessionsBefore);
      assert.equal(fetchCalls, 1);

      const secret = "sk-live-brew-parser-secret";
      installFetch(500, { error: { message: `upstream failed ${secret} Bearer test-key-not-real` } });
      const upstream = await app.inject({
        method: "POST",
        url: "/api/admin/brewery/parse-recipe",
        headers: { authorization: `Bearer ${token}` },
        payload: { text: CANDY_CLOUD_TEXT }
      });
      assert.equal(upstream.statusCode, 502);
      assert.deepEqual(upstream.json(), { error: "The AI could not parse this brewing recipe" });
      assert.equal(upstream.body.includes(secret), false);
      assert.equal(upstream.body.includes("test-key-not-real"), false);
      assert.equal(upstream.body.includes("chat/completions"), false);
      assert.equal(recipeCount(), recipesBefore);
      assert.equal(sessionCount(), sessionsBefore);
    } finally {
      restore();
    }
  });
});
