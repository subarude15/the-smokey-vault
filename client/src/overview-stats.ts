import type { OverviewSnapshot } from "./catalog";

/**
 * Pure mapping from the authoritative Overview snapshot to the six at-a-glance
 * stat definitions (PR150). This is the ONLY place the six live counts are
 * turned into display data; there is no second count source. Icons live in the
 * component so this stays trivially unit-testable.
 *
 * Returns [] when no snapshot is available so the caller renders a skeleton
 * instead of inventing zero counts while data is still loading.
 */
export type OverviewStatDef = {
  /** Navigation destination id — preserves each metric's existing tap target. */
  id: string;
  value: number;
  label: string;
  hint: string;
};

/** How many stat cards the grid renders (used for the loading skeleton). */
export const OVERVIEW_STAT_COUNT = 6;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function overviewStatDefs(
  snapshot: OverviewSnapshot | undefined,
  admin: boolean
): OverviewStatDef[] {
  if (!snapshot) return [];
  const { spirits, taps, brews, packaged, wines, cocktails } = snapshot;
  if (admin) {
    return [
      { id: "spirits", value: spirits.on_shelf, label: "ON THE SHELF", hint: spirits.low ? `${spirits.low} running low` : "Spirits & mixers" },
      { id: "taps", value: taps.pouring, label: "POURING", hint: plural(taps.empty, "open handle", "open handles") },
      { id: "brewery", value: brews.active, label: "IN THE LAB", hint: brews.archived ? `${brews.archived} archived` : "Active batches" },
      { id: "packaged_beer", value: packaged.units, label: "COLD ROOM", hint: packaged.out ? `${packaged.out} out of stock` : "Cans & bottles" },
      { id: "wines", value: wines.bottles, label: "WINE CELLAR", hint: `${wines.labels} on the rack` },
      { id: "cocktails", value: cocktails.ready, label: "READY TO POUR", hint: cocktails.almost ? `${cocktails.almost} one bottle away` : "Matched to the shelf" }
    ];
  }
  // Guest labels use the concise, PR149-aligned terminology; order matches the
  // Guest bar mental model (what's pouring → what you can drink → the shelves).
  return [
    { id: "taps", value: taps.pouring, label: "On Tap", hint: "What’s on tap tonight" },
    { id: "cocktails", value: cocktails.ready, label: "Off the menu", hint: cocktails.almost ? `${cocktails.almost} one bottle away` : "Drinks the shelf can make" },
    { id: "spirits", value: spirits.on_shelf, label: "Spirits", hint: "Spirits & mixers" },
    { id: "wines", value: wines.bottles, label: "Wine", hint: "On the rack" },
    { id: "packaged_beer", value: packaged.units, label: "Beer", hint: "Cans & bottles on hand" },
    { id: "brewery", value: brews.active, label: "Homebrews", hint: "What’s in the pipeline" }
  ];
}
