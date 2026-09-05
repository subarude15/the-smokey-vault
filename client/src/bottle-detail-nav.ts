/**
 * Bottle-detail return navigation helpers.
 * Pure functions so collection-origin / history behavior can be tested without mounting React.
 *
 * Detail lives inside Inventory today (so search/filter state survives Back). These helpers
 * make Back deterministic, support browser/system Back via history state, and never send
 * the user to Dashboard as a fallback.
 */

export const BOTTLE_DETAIL_HISTORY_FLAG = "smokeyBottleDetail" as const;

export type BottleCollectionId = "spirits" | "wines" | "packaged_beer" | "taps" | "brews";

export type BottleDetailHistoryState = {
  [BOTTLE_DETAIL_HISTORY_FLAG]: true;
  moduleId: string;
  itemId: number;
};

export type BottleCollectionHistoryState = {
  [BOTTLE_DETAIL_HISTORY_FLAG]: false;
  moduleId: string;
};

/** Modules that own a bottle/tap/brew detail surface. */
export function isBottleCollectionId(value: string): value is BottleCollectionId {
  return value === "spirits"
    || value === "wines"
    || value === "packaged_beer"
    || value === "taps"
    || value === "brews";
}

/**
 * Natural collection for an item when no prior origin was recorded.
 * Never returns dashboard/home.
 */
export function naturalCollectionForModule(moduleId: string): string {
  if (isBottleCollectionId(moduleId)) return moduleId;
  return moduleId || "spirits";
}

/**
 * Where the visible Back control should land.
 * Prefer the remembered origin collection; otherwise the item's natural collection.
 */
export function resolveDetailBackTarget(
  originModuleId: string | null | undefined,
  itemModuleId: string
): string {
  const origin = String(originModuleId ?? "").trim();
  if (origin && origin !== "dashboard") return origin;
  const fallback = naturalCollectionForModule(itemModuleId);
  return fallback === "dashboard" ? "spirits" : fallback;
}

export function isBottleDetailHistoryState(state: unknown): state is BottleDetailHistoryState {
  if (!state || typeof state !== "object") return false;
  const record = state as Record<string, unknown>;
  return record[BOTTLE_DETAIL_HISTORY_FLAG] === true
    && typeof record.moduleId === "string"
    && Number.isFinite(Number(record.itemId));
}

export function buildDetailHistoryState(moduleId: string, itemId: number): BottleDetailHistoryState {
  return {
    [BOTTLE_DETAIL_HISTORY_FLAG]: true,
    moduleId,
    itemId: Number(itemId)
  };
}

export function buildCollectionHistoryState(moduleId: string): BottleCollectionHistoryState {
  return {
    [BOTTLE_DETAIL_HISTORY_FLAG]: false,
    moduleId
  };
}

/** Avoid pushing duplicate detail entries on re-renders / repeated open of the same bottle. */
export function shouldPushDetailHistory(
  currentState: unknown,
  moduleId: string,
  itemId: number
): boolean {
  if (!isBottleDetailHistoryState(currentState)) return true;
  return currentState.moduleId !== moduleId || Number(currentState.itemId) !== Number(itemId);
}

export function pushBottleDetailHistory(
  history: Pick<History, "state" | "pushState">,
  moduleId: string,
  itemId: number
): void {
  if (!shouldPushDetailHistory(history.state, moduleId, itemId)) return;
  history.pushState(buildDetailHistoryState(moduleId, itemId), "");
}

/**
 * Visible app Back must be deterministic — do not call history.back().
 * If the current entry is our detail state, replace it with the collection entry.
 */
export function syncHistoryAfterClosingDetail(
  history: Pick<History, "state" | "replaceState">,
  moduleId: string
): void {
  if (!isBottleDetailHistoryState(history.state)) return;
  if (history.state.moduleId !== moduleId) return;
  history.replaceState(buildCollectionHistoryState(moduleId), "");
}

/** Browser/system Back: close detail when the popped state is no longer a detail entry for this module. */
export function shouldCloseDetailOnPopState(state: unknown, moduleId: string): boolean {
  if (!isBottleDetailHistoryState(state)) return true;
  return state.moduleId !== moduleId;
}
