/**
 * Navigation ownership for shelf scan sessions vs legacy single-scan / Import Review.
 * Pure helpers so session behavior can be regression-tested without mounting React.
 */

export type ShelfSessionMode = "idle" | "active" | "summary";

/** Successful / known-bottle saves must never auto-open BottleDetail during a shelf session. */
export function shelfSessionAutoOpensBottleDetail(_action: "added" | "updated" | "needs_review" | "duplicate" | "failed"): boolean {
  return false;
}

/** Needs-review saves must not auto-navigate to Import Review during a shelf session. */
export function shelfSessionAutoOpensImportReview(_action: "added" | "updated" | "needs_review" | "duplicate" | "failed"): boolean {
  return false;
}

/**
 * What the Scan tab should show given shelf-session + single-scan miss state.
 * Active/summary always win; Import Review is never the default landing.
 */
export function scanTabSurface(mode: ShelfSessionMode, _hasSingleScanMiss: boolean): "session" | "summary" | "landing" {
  if (mode === "active") return "session";
  if (mode === "summary") return "summary";
  return "landing";
}

/** Returning to Scan while a session is still active restores the continuous scanner. */
export function restoreShelfSessionOnScanTab(mode: ShelfSessionMode): boolean {
  return mode === "active";
}

/** Explicit exits that may leave an active shelf session. */
export function isExplicitShelfSessionExit(reason: "finish" | "review_now" | "view_bottle" | "navigate_away" | "auto_save"): boolean {
  return reason === "finish" || reason === "review_now" || reason === "view_bottle" || reason === "navigate_away";
}

/** Review now navigates to Import Review but should keep the session alive for return. */
export function reviewNowEndsShelfSession(): boolean {
  return false;
}

/** Finish scanning is the normal way to end the continuous session. */
export function finishScanningEndsShelfSession(): boolean {
  return true;
}
