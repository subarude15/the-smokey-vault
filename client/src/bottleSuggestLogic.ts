/** Pure BottleSuggest helpers — abort/stale guards, keyboard, ARIA ids. */

export const BOTTLE_SUGGEST_MIN_QUERY = 2;
export const BOTTLE_SUGGEST_DEBOUNCE_MS = 280;
export const BOTTLE_SUGGEST_MAX_RESULTS = 8;

export type BottleSuggestStatus = "idle" | "loading" | "ready" | "empty" | "error";

export function shouldOpenBottleSuggest(query: string, locked: string): boolean {
  const q = query.trim();
  return q.length >= BOTTLE_SUGGEST_MIN_QUERY && q !== locked.trim();
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: string }).name ?? "");
  return name === "AbortError";
}

export function isCurrentRequest(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}

/** Abort + request-id guard: never apply aborted or superseded responses. */
export function shouldApplySearchResponse(
  requestId: number,
  latestRequestId: number,
  aborted: boolean
): boolean {
  if (aborted) return false;
  return isCurrentRequest(requestId, latestRequestId);
}

/**
 * Runs one autocomplete fetch with abort + stale-response protection.
 * AbortError is ignored; only the latest requestId may commit success/error.
 */
export async function runBottleSuggestSearch<T>(opts: {
  requestId: number;
  getLatestRequestId: () => number;
  signal: AbortSignal;
  fetch: (signal: AbortSignal) => Promise<T>;
  onSuccess: (data: T) => void;
  onError: () => void;
}): Promise<void> {
  try {
    const data = await opts.fetch(opts.signal);
    if (!shouldApplySearchResponse(opts.requestId, opts.getLatestRequestId(), opts.signal.aborted)) {
      return;
    }
    opts.onSuccess(data);
  } catch (error) {
    if (isAbortError(error) || opts.signal.aborted) return;
    if (!shouldApplySearchResponse(opts.requestId, opts.getLatestRequestId(), false)) return;
    opts.onError();
  }
}

export function moveActiveIndex(
  current: number,
  resultCount: number,
  direction: "down" | "up" | "home" | "end"
): number {
  if (resultCount <= 0) return -1;
  if (direction === "home") return 0;
  if (direction === "end") return resultCount - 1;
  if (direction === "down") {
    if (current < 0) return 0;
    return Math.min(resultCount - 1, current + 1);
  }
  if (current < 0) return resultCount - 1;
  return Math.max(0, current - 1);
}

export function clampActiveIndex(active: number, resultCount: number): number {
  if (resultCount <= 0) return -1;
  if (active < 0) return 0;
  return Math.min(active, resultCount - 1);
}

export function suggestListId(instanceId: string): string {
  return `bottle-suggest-list-${instanceId}`;
}

export function suggestOptionId(instanceId: string, index: number): string {
  return `bottle-suggest-option-${instanceId}-${index}`;
}

export function suggestStatusId(instanceId: string): string {
  return `bottle-suggest-status-${instanceId}`;
}

export function suggestStatusText(status: BottleSuggestStatus, resultCount: number): string {
  switch (status) {
    case "loading":
      return "Searching";
    case "ready":
      return resultCount === 1 ? "1 result" : `${resultCount} results`;
    case "empty":
      return "No matches";
    case "error":
      return "Search unavailable";
    case "idle":
      return "";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export type BottleSuggestKeyAction =
  | { type: "move"; direction: "down" | "up" | "home" | "end" }
  | { type: "select" }
  | { type: "close" }
  | { type: "custom" }
  | { type: "none" };

/** Tab intentionally returns none — no focus trap, no auto-select. */
export function mapSuggestKey(
  key: string,
  opts: { open: boolean; hasCustomAdd: boolean; activeIndex: number; resultCount: number }
): BottleSuggestKeyAction {
  if (!opts.open) return { type: "none" };
  switch (key) {
    case "ArrowDown":
      return { type: "move", direction: "down" };
    case "ArrowUp":
      return { type: "move", direction: "up" };
    case "Home":
      return { type: "move", direction: "home" };
    case "End":
      return { type: "move", direction: "end" };
    case "Enter":
      if (opts.activeIndex >= 0 && opts.activeIndex < opts.resultCount) return { type: "select" };
      if (opts.hasCustomAdd && opts.resultCount === 0) return { type: "custom" };
      return { type: "none" };
    case "Escape":
      return { type: "close" };
    default:
      return { type: "none" };
  }
}

/**
 * Popup layout contract for a11y: manual-add is never a listbox option.
 * Keep results/status inside the listbox; place custom-add as a sibling below.
 */
export function bottleSuggestPanelLayout(opts: {
  open: boolean;
  resultCount: number;
  showCustom: boolean;
}): {
  listboxIncludesCustomAdd: false;
  customAddOutsideListbox: boolean;
  listboxHasOptions: boolean;
  expanded: boolean;
} {
  return {
    listboxIncludesCustomAdd: false,
    customAddOutsideListbox: opts.showCustom,
    listboxHasOptions: opts.resultCount > 0,
    // Popup stays expanded for custom-add-only (zero options) as well as results.
    expanded: opts.open
  };
}
