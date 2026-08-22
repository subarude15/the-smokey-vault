import { FILL_STOPS } from "./catalog.js";

export type RestockKind = "spirits" | "wines" | "packaged_beer" | "ingredient" | "wanted";
export type WantedLabel = "bottle" | "mixer";

export const MAX_WANTED_NAME = 80;
export const MAX_WANTED_NOTE = 160;

export type WantedRow = {
  id: number;
  name: string;
  note: string;
  label: WantedLabel;
  created_at: string;
};

export type RestockThresholds = {
  packagedBelow: number;
  spiritFill: number;
  wineBelow: number;
};

export const DEFAULT_RESTOCK_THRESHOLDS: RestockThresholds = {
  packagedBelow: 3,
  spiritFill: 25,
  wineBelow: 2
};

export const RESTOCK_PACKAGED_STOPS = [1, 2, 3, 4, 6, 12];
export const RESTOCK_WINE_STOPS = [2, 3, 4, 6];
export const RESTOCK_SPIRIT_STOPS = FILL_STOPS.filter((stop) => stop.percent <= 75).map((stop) => stop.percent);

function pickStop(value: unknown, stops: number[], fallback: number): number {
  const n = Math.floor(Number(value));
  return stops.includes(n) ? n : fallback;
}

export function parseRestockThresholds(settings?: Record<string, string | undefined> | null): RestockThresholds {
  return {
    packagedBelow: pickStop(settings?.restockPackagedBelow, RESTOCK_PACKAGED_STOPS, DEFAULT_RESTOCK_THRESHOLDS.packagedBelow),
    spiritFill: pickStop(settings?.restockSpiritFill, RESTOCK_SPIRIT_STOPS, DEFAULT_RESTOCK_THRESHOLDS.spiritFill),
    wineBelow: pickStop(settings?.restockWineBelow, RESTOCK_WINE_STOPS, DEFAULT_RESTOCK_THRESHOLDS.wineBelow)
  };
}

export type RestockItem = {
  key: string;
  kind: RestockKind;
  name: string;
  reason: string;
  module?: RestockKind;
  id?: number;
  image_url: string;
  got: boolean;
};

const SHARE_GROUPS: Array<{ kind: RestockKind; heading: string }> = [
  { kind: "wanted", heading: "Wanted" },
  { kind: "spirits", heading: "Spirits" },
  { kind: "wines", heading: "Wine" },
  { kind: "packaged_beer", heading: "Cold room" },
  { kind: "ingredient", heading: "Mixers" }
];

export function formatRestockShare(items: RestockItem[]): string {
  const open = items.filter((item) => !item.got);
  if (!open.length) return "";
  const lines = ["The Smokey Vault — pick up"];
  for (const group of SHARE_GROUPS) {
    const rows = open.filter((item) => item.kind === group.kind);
    if (!rows.length) continue;
    lines.push("", group.heading);
    for (const item of rows) {
      lines.push(`☐ ${item.name}${item.reason ? ` — ${item.reason}` : ""}`);
    }
  }
  return lines.join("\n");
}
