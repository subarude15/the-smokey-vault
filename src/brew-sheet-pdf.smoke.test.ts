import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";

const enabled = process.env.BREW_PDF_SMOKE === "1";

const candy = {
  beerName: "Candy Cloud Hazy DIPA",
  style: "Hazy Double IPA",
  system: "SS Brewtech V3 3-Kettle Electric",
  fermenter: "7 gal FermZilla",
  targetPackaged: "5.0 gal",
  fermenterVolume: "5.5 gal",
  boilTime: "60 min",
  targetOg: "1.080",
  targetFg: "1.018",
  targetAbv: "7.8%",
  estimatedIbu: "45",
  mashEfficiency: "75%",
  warnings: ["Do not add Whirlfloc."],
  checklist: ["Calibrate pH meter", "Sanitise fermenter"],
  notes: "Keep the fermenter closed after the dry hop.",
  water: {
    source: "RO",
    strikeWater: "5.50 Gallons",
    spargeWater: "4.00 Gallons",
    mashTemperature: "152°F",
    mashDuration: "60 min",
    targetMashPh: "5.30",
    chloridePpm: "150",
    sulfatePpm: "80",
    calciumPpm: "100",
    sodiumPpm: "40",
    magnesiumPpm: "10"
  },
  fermentables: [
    { ingredient: "2-Row Pale Malt", amount: "11.50 lbs", lovibond: "2", percentage: "70%" },
    { ingredient: "Flaked Oats", amount: "2.00 lbs", lovibond: "1", percentage: "12%" },
    { ingredient: "White Wheat Malt", amount: "1.50 lbs", lovibond: "2", percentage: "9%" }
  ],
  kettleAdditions: [
    { time: "60 min", ingredient: "Magnum", amount: "0.50 oz", role: "Bittering" }
  ],
  whirlpoolAdditions: [
    { ingredient: "Mosaic LUPOMAX", amount: "2.00 oz", temperature: "170°F", time: "20 min" },
    { ingredient: "Citra LUPOMAX", amount: "2.00 oz", temperature: "170°F", time: "20 min" }
  ],
  dryHopStages: [
    { stage: "DH #1", variety: "Citra LUPOMAX", amount: "1.5 oz", when: "Day 2", temperature: "68°F" }
  ],
  fermentation: {
    yeast: "London Fog III",
    pitchRate: "1.0",
    pitchTemperature: "66°F",
    steps: [
      { when: "Day 3", temperature: "72°F", gravity: "1.030", action: "Raise and keep closed" }
    ]
  },
  packaging: { targetCO2: "2.4 vol", steps: ["Closed transfer to keg"] }
};

const longRecipe = {
  ...candy,
  beerName: "Long Hop Log",
  fermentables: Array.from({ length: 18 }, (_, index) => ({
    ingredient: `Malt ${index + 1} Extra Pale`,
    amount: `${index + 1}.00 lbs`,
    lovibond: "2",
    percentage: "5%"
  })),
  fermentation: {
    yeast: "London Fog III",
    pitchRate: "1.0",
    steps: Array.from({ length: 14 }, (_, index) => ({
      when: `Day ${index + 1}`,
      temperature: "68°F",
      gravity: "1.040",
      action: `Check the fermenter and record gravity reading ${index + 1}`
    }))
  },
  notes: "This sheet is intentionally long so the second page can be checked for clipped rows."
};

test("chromium prints a real brew sheet PDF", { skip: !enabled }, async () => {
  assert.equal(existsSync("client/dist/brew-sheet-print.html"), true, "build the client before this smoke");
  const chrome = process.env.CHROMIUM_PATH || "/usr/bin/google-chrome";
  assert.equal(existsSync(chrome), true, chrome);
  process.env.CHROMIUM_PATH = chrome;
  process.env.BREW_SHEET_PRINT_ORIGIN = "http://127.0.0.1:8091";
  const { app, createTestAdminToken } = await import("./server.js");
  const { db } = await import("./db.js");
  await app.listen({ port: 8091, host: "127.0.0.1" });
  const headers = { authorization: `Bearer ${createTestAdminToken()}` };
  const ids: number[] = [];
  try {
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    for (const [name, recipe, file] of [
      ["Candy Cloud Hazy DIPA", candy, "/opt/cursor/artifacts/candy-cloud-brew-sheet.pdf"],
      ["Long Hop Log", longRecipe, "/opt/cursor/artifacts/long-brew-sheet.pdf"]
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/brewery/recipes",
        headers,
        payload: { name, style: "Hazy DIPA", sourceText: "secret source", recipe }
      });
      assert.equal(created.statusCode, 201);
      const id = (created.json() as { recipe: { id: number } }).recipe.id;
      ids.push(id);
      const pdf = await app.inject({ method: "GET", url: `/api/admin/brewery/recipes/${id}/pdf`, headers });
      assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));
      assert.match(pdf.headers["content-type"] ?? "", /application\/pdf/);
      assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
      assert.ok(pdf.rawPayload.length > 5_000);
      writeFileSync(file, pdf.rawPayload);
    }
  } finally {
    for (const id of ids) db.prepare("DELETE FROM brew_recipes WHERE id=?").run(id);
    await app.close();
  }
});
