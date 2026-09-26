/**
 * Keeper-facing water chemistry summary derived from recipe.water + fermentables.
 * Recalculates on every edit — no stored salt-gram fields.
 */
import {
  calculateWaterChemistry,
  formatGrams,
  formatPpm,
  ionLabel,
  type MineralIon,
  type WaterChemistryResult
} from "../../src/brew_water_chemistry";
import type { BrewRecipeDraft } from "./brew-recipe-builder";

export type WaterChemistryView = {
  source: string;
  volumes: { label: string; value: string }[];
  targets: { label: string; value: string }[];
  mashSalts: { label: string; value: string }[];
  spargeSalts: { label: string; value: string }[];
  totalSalts: { label: string; value: string }[];
  canSplit: boolean;
  achieved: { label: string; value: string }[];
  mineralStatus: string | null;
  mashPhTarget: string;
  lactic: string;
  mashPhNote: string;
  measuredLine: string;
};

export function waterChemistryView(draft: BrewRecipeDraft): WaterChemistryView {
  const result = calculateWaterChemistry({ water: draft.water, fermentables: draft.fermentables });
  return toView(result);
}

function toView(result: WaterChemistryResult): WaterChemistryView {
  const { minerals, mashPh } = result;
  const volumes: { label: string; value: string }[] = [];
  if (minerals.volumes.strikeGal != null) {
    volumes.push({ label: "Mash / Strike", value: `${minerals.volumes.strikeGal.toFixed(2)} gal` });
  }
  if (minerals.volumes.spargeGal != null) {
    volumes.push({ label: "Sparge", value: `${minerals.volumes.spargeGal.toFixed(2)} gal` });
  }
  if (minerals.volumes.totalGal != null) {
    volumes.push({ label: "Total", value: `${minerals.volumes.totalGal.toFixed(2)} gal` });
  }

  const targets = minerals.targetDisplay.map((row) => ({
    label: row.label,
    value: row.calcPpm != null
      ? `${row.raw} → calc target ${formatPpm(row.calcPpm, row.calcPpm % 1 === 0 ? 0 : 1)}`
      : row.raw
  }));

  const mashSalts = minerals.volumes.canSplit
    ? minerals.salts.map((salt) => ({ label: salt.label, value: formatGrams(salt.mashGrams as number) }))
    : [];
  const spargeSalts = minerals.volumes.canSplit
    ? minerals.salts.map((salt) => ({ label: salt.label, value: formatGrams(salt.spargeGrams as number) }))
    : [];
  const totalSalts = minerals.salts.map((salt) => ({ label: salt.label, value: formatGrams(salt.totalGrams) }));

  const achieved = Object.entries(minerals.achieved).map(([ion, ppm]) => {
    const key = ion as MineralIon;
    const row = minerals.targetDisplay.find((item) => item.ion === key);
    return { label: row?.label ?? ionLabel(key), value: formatPpm(ppm as number, 1) };
  });

  return {
    source: minerals.source,
    volumes,
    targets,
    mashSalts,
    spargeSalts,
    totalSalts,
    canSplit: minerals.volumes.canSplit,
    achieved,
    mineralStatus: minerals.statusMessage,
    mashPhTarget: mashPh.target.label,
    lactic: mashPh.lacticLabel,
    mashPhNote: mashPh.note,
    measuredLine: "Measured Mash pH: __________"
  };
}
