import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brewSheetModel } from "../client/src/brew-sheet-document.ts";
import { closePreview, openPreview, openSavedRecipe } from "../client/src/brew-recipe-builder.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const builderSrc = readFileSync(join(root, "client/src/BrewRecipeBuilder.tsx"), "utf8");
const documentSrc = readFileSync(join(root, "client/src/BrewSheetDocument.tsx"), "utf8");
const previewSrc = readFileSync(join(root, "client/src/BrewSheetPreview.tsx"), "utf8");
const sheetCss = readFileSync(join(root, "client/src/brew-sheet-document.css"), "utf8");
const packageJson = readFileSync(join(root, "package.json"), "utf8");

const LONG_MALT = "Extra Long Pale Malt Name That Must Not Be Truncated By The Preview Helpers At All";

const candy = {
  beerName: "Candy Cloud Hazy DIPA",
  style: "Hazy DIPA",
  system: "SS Brewtech V3 3-Kettle Electric",
  fermenter: "7-Gal Unitank",
  targetPackaged: "6.0 Gal",
  fermenterVolume: "6.5 Gal",
  boilTime: "60 min",
  targetOg: "~1.080",
  targetFg: "1.020 – 1.022",
  targetAbv: "~7.8%",
  estimatedIbu: "~25",
  mashEfficiency: "72%",
  water: {
    source: "100% Reverse Osmosis",
    strikeWater: "5.50 gal",
    spargeWater: "4.50 gal",
    targetMashPh: "5.20–5.35",
    chloridePpm: "200–225 ppm",
    sulfatePpm: "50–65 ppm",
    calciumPpm: "100–120 ppm",
    sodiumPpm: "40",
    magnesiumPpm: "10",
    profile: { hidden: true }
  },
  fermentables: [
    { ingredient: LONG_MALT, amount: "11.50 lb", lovibond: "2", ppg: "36" },
    { ingredient: "Flaked Oats", amount: "4.00 lb" }
  ],
  kettleAdditions: [{ ingredient: "Warrior", amount: "0.5 oz", time: "60 min", role: "Bittering" }],
  whirlpoolAdditions: [{ ingredient: "Mosaic Incognito", amount: "16 g", temperature: "170–175°F", time: "20 min" }],
  dryHopStages: [
    { stage: "DH #1", variety: "Citra LUPOMAX", amount: "1.5 oz", when: "Day 2", gravity: "~1.040" },
    { stage: "DH #2", variety: "Mosaic LUPOMAX", amount: "1.5 oz", when: "58°F" }
  ],
  fermentation: {
    yeast: "WLP066 London Fog",
    pitchRate: "1.0 million cells/mL/°P",
    steps: [
      { when: "Day 1", temperature: "68°F", gravity: "1.080", action: "Pitch" },
      { when: "Day 4", temperature: "34–36°F", action: "Cold crash 48 hours" }
    ]
  },
  packaging: { steps: ["Closed CO2 transfer into a purged Corny keg"] },
  warnings: ["Do not add Whirlfloc / Irish Moss", "Keep the transfer oxygen-free"],
  checklist: ["Mash complete", "Boil complete"],
  notes: "Stash-buster edition"
};

test("a Candy Cloud-style recipe maps onto the brew sheet sections", () => {
  const sheet = brewSheetModel(candy);
  assert.equal(sheet.beerName, "Candy Cloud Hazy DIPA");
  assert.equal(sheet.style, "Hazy DIPA");
  assert.equal(sheet.system, "SS Brewtech V3 3-Kettle Electric");
  assert.deepEqual(sheet.stats.map((stat) => stat.label), [
    "Target packaged",
    "Fermenter volume",
    "Boil time",
    "Target OG",
    "Target FG",
    "Target ABV",
    "Estimated IBU",
    "Mash efficiency"
  ]);
  assert.equal(sheet.stats.find((stat) => stat.label === "Target OG")?.value, "~1.080");
  assert.equal(sheet.stats.find((stat) => stat.label === "Target OG")?.writeIn, "Actual OG");
  assert.equal(sheet.fermentables?.rows[0][1], LONG_MALT);
  assert.equal(sheet.fermentables?.rows[0].join(" ").includes(LONG_MALT), true);
  assert.equal(JSON.stringify(sheet).includes("…"), false);
  assert.equal(JSON.stringify(sheet).includes("[object Object]"), false);
});

test("target stats include only values the recipe actually has", () => {
  const sheet = brewSheetModel({ beerName: "Small Beer", targetOg: "1.040" });
  assert.deepEqual(sheet.stats.map((stat) => [stat.label, stat.value]), [["Target OG", "1.040"]]);
  assert.equal(sheet.stats.some((stat) => stat.label === "Estimated IBU" || stat.value === "1.050"), false);
});

test("water chemistry uses deterministic salt calc and keeps leftover scalars", () => {
  const sheet = brewSheetModel(candy);
  assert.ok(sheet.waterChemistry);
  assert.equal(sheet.waterChemistry?.source, "RO / distilled");
  assert.ok(sheet.waterChemistry?.targetProfile.some((pair) => pair.label === "Ca"));
  assert.ok(sheet.waterChemistry?.targetProfile.some((pair) => pair.label === "Cl"));
  assert.ok(sheet.waterChemistry?.targetProfile.some((pair) => pair.label === "SO4"));
  assert.ok(sheet.waterChemistry?.targetProfile.some((pair) => pair.label === "Na"));
  assert.ok(sheet.waterChemistry?.targetProfile.some((pair) => pair.label === "Mg"));
  assert.ok(sheet.waterChemistry?.saltTable);
  assert.ok(sheet.waterChemistry?.achievedProfile.length);
  assert.ok(sheet.waterChemistry?.mashPh.target);
  assert.match(sheet.waterChemistry?.mashPh.lactic ?? "", /Determine starting dose from measured mash pH|Not calculated/i);
  assert.doesNotMatch(sheet.waterChemistry?.mashPh.lactic ?? "", /\d+(\.\d+)?\s*mL/i);
  assert.equal(sheet.waterChemistry?.mashPh.measuredWriteIn, true);
  assert.equal(sheet.water.some((pair) => pair.label === "Profile" || pair.value.includes("hidden")), false);
  assert.ok(sheet.measurements.includes("Mash pH"));
});

test("BrewSheetDocument still owns preview and PDF chemistry rendering", () => {
  assert.match(documentSrc, /waterChemistry/);
  assert.match(documentSrc, /88% Lactic Acid/);
  assert.match(documentSrc, /Measured pH/);
  assert.match(documentSrc, /Salt additions|saltTable/);
  assert.doesNotMatch(documentSrc, /fetch\(|\bapi\(/);
});

test("kettle additions stay separate from whirlpool additions", () => {
  const sheet = brewSheetModel(candy);
  assert.equal(sheet.kettle?.rows.some((row) => row.includes("Warrior")), true);
  assert.equal(sheet.whirlpool?.rows.some((row) => row.includes("Mosaic Incognito")), true);
  assert.equal(sheet.kettle?.rows.some((row) => row.join(" ").includes("Mosaic Incognito")), false);
  assert.equal(sheet.whirlpool?.rows.some((row) => row.join(" ").includes("Warrior")), false);
});

test("dry hop stages keep DH #1 and DH #2 apart", () => {
  const sheet = brewSheetModel(candy);
  assert.deepEqual(sheet.dryHops.map((block) => block.stage), ["DH #1", "DH #2"]);
  assert.equal(sheet.dryHops[0].table.rows[0].join(" ").includes("Citra LUPOMAX"), true);
  assert.equal(sheet.dryHops[1].table.rows[0].join(" ").includes("Mosaic LUPOMAX"), true);
  assert.equal(sheet.dryHops[0].table.rows[0].join(" ").includes("DH #2"), false);
});

test("warnings come from recipe.warnings", () => {
  const sheet = brewSheetModel(candy);
  assert.deepEqual(sheet.warnings, ["Do not add Whirlfloc / Irish Moss", "Keep the transfer oxygen-free"]);
  assert.equal(brewSheetModel({ beerName: "Quiet", warnings: [] }).warnings.length, 0);
});

test("fermentation steps stay in recipe order", () => {
  const sheet = brewSheetModel(candy);
  assert.equal(sheet.yeast, "WLP066 London Fog");
  assert.equal(sheet.fermentationFields.some((pair) => pair.label === "Pitch rate" && pair.value.includes("1.0")), true);
  assert.equal(sheet.fermentationSteps?.rows[0].join(" ").includes("Day 1"), true);
  assert.equal(sheet.fermentationSteps?.rows[1].join(" ").includes("Cold crash 48 hours"), true);
  assert.ok(sheet.measurements.includes("Cold crash date"));
  assert.ok(sheet.measurements.includes("DH #1 date"));
  assert.ok(sheet.measurements.includes("DH #2 date"));
});

test("missing recipe values are omitted instead of invented", () => {
  const sheet = brewSheetModel({ beerName: "Only a name" });
  assert.equal(sheet.stats.length, 0);
  assert.equal(sheet.water.length, 0);
  assert.equal(sheet.waterChemistry, null);
  assert.equal(sheet.fermentables, null);
  assert.equal(sheet.kettle, null);
  assert.equal(sheet.whirlpool, null);
  assert.equal(sheet.dryHops.length, 0);
  assert.equal(sheet.checklist.length, 0);
  assert.equal(sheet.notes, "");
  assert.equal(sheet.measurements.length, 0);
});

test("preview stays the canonical document and PDF download is keeper-only", () => {
  const opened = openSavedRecipe({
    recipe: { id: 4, sourceText: "original", recipe: candy },
    sessions: [{ id: 1, brewNumber: 2, brewedAt: null, createdAt: "2026-09-25 12:00:00", status: "Planned" }]
  });
  assert.ok(opened);
  const preview = openPreview(opened);
  assert.equal(preview.phase, "preview");
  assert.equal(preview.savedId, 4);
  assert.equal(preview.draft, opened.draft);
  assert.equal(preview.rawText, "original");
  assert.equal(preview.sessions[0].brewNumber, 2);
  assert.equal(closePreview(preview).phase, "review");
  assert.equal(openPreview({ ...opened, savedId: null }).phase, "review");
  assert.match(builderSrc, /Preview Brew Sheet/);
  assert.match(builderSrc, /BrewSheetPreview/);
  assert.doesNotMatch(appSrc, /BrewSheetPreview/);
  assert.match(appSrc, /page === BREW_SHEET_PAGE_ID && admin && <BrewRecipeBuilder\/>/);
  assert.doesNotMatch(documentSrc, /fetch\(|\bapi\(/);
  assert.match(previewSrc, /Print Preview/);
  assert.match(previewSrc, /Download PDF/);
  assert.match(builderSrc, /canDownload=\{pdfReady\}/);
  assert.doesNotMatch(appSrc, /Download PDF/);
  assert.match(sheetCss, /@page brew-sheet/);
  assert.match(sheetCss, /@media print/);
  assert.match(packageJson, /"playwright-core"/);
  assert.equal(packageJson.includes("puppeteer"), false);
  assert.equal(packageJson.includes("pdfkit"), false);
  assert.equal(packageJson.includes("jspdf"), false);
  assert.equal(packageJson.includes("html2canvas"), false);
  assert.equal(documentSrc.includes("function BrewSheetDocument"), true);
  assert.equal(builderSrc.includes("function BrewSheetDocument"), false);
});
