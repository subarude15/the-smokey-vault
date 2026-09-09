/**
 * PR151 — Inventory collection presentation state.
 * Empty is never derived from a zero-length list while the request is still pending.
 */
export type InventoryViewState = "loading" | "error" | "empty" | "filtered-empty" | "populated";

export function inventoryViewState(opts: {
  loading: boolean;
  error: string;
  itemCount: number;
  filteredCount: number;
}): InventoryViewState {
  if (opts.error) return "error";
  if (opts.loading) return "loading";
  if (opts.itemCount === 0) return "empty";
  if (opts.filteredCount === 0) return "filtered-empty";
  return "populated";
}
