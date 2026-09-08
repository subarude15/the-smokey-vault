import { readFileSync, writeFileSync, rmSync } from "node:fs";

const appPath = "client/src/App.tsx";
let app = readFileSync(appPath, "utf8");

function replaceOnce(label, before, after) {
  const first = app.indexOf(before);
  if (first < 0) throw new Error(`${label}: anchor not found`);
  if (app.indexOf(before, first + before.length) >= 0) throw new Error(`${label}: anchor is not unique`);
  app = app.replace(before, after);
}

replaceOnce(
  "card import",
  'import { CommercialTapEnrichmentPanel } from "./CommercialTapEnrichmentPanel";\n',
  'import { CommercialTapEnrichmentPanel } from "./CommercialTapEnrichmentPanel";\nimport { SpiritInventoryCard, TapInventoryCard } from "./TapSpiritInventoryCard";\n'
);

replaceOnce(
  "Inventory call brewery callback",
  '            ensureCollection={() => navigate(module.id)}\n            seedCreate={module.id === "taps" ? tapSeed : undefined}\n',
  '            ensureCollection={() => navigate(module.id)}\n            openBreweryLab={() => navigate("brewery")}\n            seedCreate={module.id === "taps" ? tapSeed : undefined}\n'
);

replaceOnce(
  "Inventory props signature",
  'function Inventory({ module, admin, scanDraft, finishScanReview, openScanner, openItem, onOpenItemConsumed, seedCreate, onSeedConsumed, onPutOnTap, ensureCollection }: {\n',
  'function Inventory({ module, admin, scanDraft, finishScanReview, openScanner, openItem, onOpenItemConsumed, seedCreate, onSeedConsumed, onPutOnTap, ensureCollection, openBreweryLab }: {\n'
);

replaceOnce(
  "Inventory props type",
  '  seedCreate?: Item; onSeedConsumed?: () => void; onPutOnTap?: (item: Item) => void;\n  /** Safety net: keep/return the user on this module\'s collection after closing detail. */\n',
  '  seedCreate?: Item; onSeedConsumed?: () => void; onPutOnTap?: (item: Item) => void;\n  openBreweryLab?: () => void;\n  /** Safety net: keep/return the user on this module\'s collection after closing detail. */\n'
);

replaceOnce(
  "specialized cards",
  '        const archived = module.id === "brews" && normalizeBrewStatus(item.status) === "Archived";\n        // Guest inventory responses redact counts and send coarse out_of_stock.\n',
  `        const archived = module.id === "brews" && normalizeBrewStatus(item.status) === "Archived";\n        if (module.id === "taps") {\n          return <TapInventoryCard\n            key={item.id}\n            item={item}\n            admin={admin}\n            onOpenDetail={() => openBottleDetail(item, module.id)}\n            onEdit={() => setEditing(item)}\n            onUpdated={(next) => setItems((current) => current.map((row) => Number(row.id) === Number(next.id) ? next : row))}\n            onClearTap={() => { void clearTap(item); }}\n            onOpenBreweryLab={openBreweryLab}\n          />;\n        }\n        if (module.id === "spirits") {\n          return <SpiritInventoryCard\n            key={item.id}\n            item={item}\n            admin={admin}\n            onOpenDetail={() => openBottleDetail(item, module.id)}\n            onEdit={() => setEditing(item)}\n            onUpdated={(next) => setItems((current) => current.map((row) => Number(row.id) === Number(next.id) ? next : row))}\n          />;\n        }\n        // Guest inventory responses redact counts and send coarse out_of_stock.\n`
);

writeFileSync(appPath, app);

// One-shot scaffolding: remove the codemod + workflow from the resulting product commit.
rmSync("scripts/pr135-apply.mjs", { force: true });
rmSync(".github/workflows/pr135-apply.yml", { force: true });
