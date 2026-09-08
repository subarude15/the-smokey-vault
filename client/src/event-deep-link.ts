/**
 * Stable guest-facing event deep links for the state-based SPA.
 * Format: `?event=<id>` — deterministic, bookmarkable, refresh-safe.
 */

export function parseEventIdFromSearch(search: string): number | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const value = params.get("event");
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Absolute deep-link URL for sharing a specific event. */
export function buildEventDeepLink(origin: string, pathname: string, eventId: number): string {
  const url = new URL(pathname || "/", origin);
  url.searchParams.set("event", String(eventId));
  return url.href;
}

/** Merge or clear the `event` search param while preserving unrelated query keys. */
export function withEventSearchParam(search: string, eventId: number | null): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  if (eventId == null) params.delete("event");
  else params.set("event", String(eventId));
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function syncEventDeepLinkUrl(
  location: Pick<Location, "pathname" | "search">,
  history: Pick<History, "replaceState" | "pushState">,
  eventId: number | null,
  mode: "replace" | "push" = "replace"
): void {
  const nextSearch = withEventSearchParam(location.search, eventId);
  if (nextSearch === (location.search || "")) return;
  const url = `${location.pathname || "/"}${nextSearch}`;
  if (mode === "push") history.pushState({}, "", url);
  else history.replaceState({}, "", url);
}
