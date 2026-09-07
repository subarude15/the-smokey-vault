/**
 * Guest-safe availability helpers for inventory cards and bottle detail.
 * Prefer server-derived `availability_pct` over raw Keeper quantities.
 */
import { fillStopLabel, kegFillPercent, nearestFillStop, pintsRemaining } from "./catalog";

export function readAvailabilityPct(item: Record<string, unknown>): number | null {
  if (typeof item.availability_pct === "number" && Number.isFinite(item.availability_pct)) {
    return Math.max(0, Math.min(100, item.availability_pct));
  }
  return null;
}

/** Spirit fill label for guests: coarse stop text, with "Last pours only" at empty. */
export function guestSpiritAvailabilityLabel(pct: number): string {
  return pct <= 0 ? "Last pours only" : fillStopLabel(pct);
}

/** Tap keg label for guests: stop text, never exact pint counts. */
export function guestTapAvailabilityLabel(pct: number): string {
  return pct <= 0 ? "Kicked" : fillStopLabel(pct);
}

/** Keeper spirit gauge uses raw fill_level; Guest Mode uses availability_pct. */
export function spiritGaugePct(item: Record<string, unknown>, admin: boolean): number | null {
  if (admin) return nearestFillStop(item.fill_level);
  return readAvailabilityPct(item);
}

/**
 * Keeper tap gauge uses remaining_l / keg_size_l (+ exact pints in the label).
 * Guest Mode uses availability_pct only.
 */
export function tapGaugeForDisplay(
  item: Record<string, unknown>,
  admin: boolean,
  defaultKegL: number
): { pct: number; label: string } | null {
  if (admin) {
    const remaining = Number(item.remaining_l ?? 0);
    const size = Number(item.keg_size_l || defaultKegL);
    const pints = pintsRemaining(remaining);
    const pct = kegFillPercent(remaining, size);
    const label = remaining <= 0
      ? "Kicked"
      : `${pints} pint${pints === 1 ? "" : "s"} left`;
    return { pct, label };
  }
  const pct = readAvailabilityPct(item);
  if (pct == null) return null;
  return { pct, label: guestTapAvailabilityLabel(pct) };
}
