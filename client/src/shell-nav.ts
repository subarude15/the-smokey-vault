/**
 * Pure shell / navigation helpers for the responsive App shell (PR134).
 * Keep page semantics, tab settings, and Guest/Keeper partition testable
 * without mounting App.
 */
import type { EnabledTabs, TabKey } from "./catalog";

/** Operational pages Guest Mode must never land on or list. */
export const GUEST_HIDDEN_PAGES = new Set([
  "scan",
  "import",
  "restock",
  "settings",
  "messages",
  "brews"
]);

/**
 * Pages that ignore Guest tab switches (always reachable in Keeper Mode).
 * Does not grant Guest access — use GUEST_HIDDEN_PAGES for that.
 * Homebrew Log (`brews`) stays tab-gated via PAGE_TAB → brewery.
 */
export const KEEPER_PAGES = new Set([
  "scan",
  "import",
  "restock",
  "settings",
  "messages"
]);

/** Which Guest tab switch controls each page. */
export const PAGE_TAB: Record<string, TabKey> = {
  dashboard: "overview",
  cocktails: "cocktails",
  mixologist: "cocktails",
  spirits: "cellar",
  wines: "cellar",
  packaged_beer: "cellar",
  taps: "brewery",
  brews: "brewery",
  brewery: "brewery",
  patrons: "patrons",
  staff: "staff",
  gallery: "gallery",
  events: "events",
  tipjar: "tipjar",
  merch: "merch",
  next: "whatsnext"
};

/** Concise labels for the phone bottom bar. */
export const MOBILE_SHORT_LABELS: Record<string, string> = {
  dashboard: "Home",
  taps: "On Tap",
  cocktails: "Drinks",
  gallery: "Gallery",
  events: "Events",
  patrons: "Regulars",
  staff: "Crew",
  tipjar: "Tips",
  merch: "Merch",
  next: "Feedback",
  brewery: "Brewery",
  spirits: "Spirits",
  wines: "Wine",
  brews: "Brews",
  packaged_beer: "Beer",
  scan: "Scan",
  import: "Import",
  messages: "Inbox",
  restock: "Restock",
  settings: "Settings"
};

/** Preferred Guest primary destinations (visibility/order still authoritative). */
export const GUEST_PRIMARY_PREFERENCE = ["dashboard", "taps", "cocktails", "gallery"] as const;

/** Preferred Keeper primary destinations — Scan is the one Keeper shortcut. */
export const KEEPER_PRIMARY_PREFERENCE = ["dashboard", "scan", "taps", "cocktails"] as const;

/** Phone bottom row capacity for primary destinations (More is separate). */
export const PRIMARY_NAV_CAPACITY = 4;

/** Guest landing candidate order before tabRank sorting. */
export const GUEST_LANDING_CANDIDATES = [
  "dashboard",
  "taps",
  "brewery",
  "cocktails",
  "spirits",
  "wines",
  "packaged_beer",
  "patrons",
  "staff",
  "gallery",
  "events",
  "tipjar",
  "merch",
  "next"
] as const;

export type ShellNavItem = {
  id: string;
  label: string;
};

export function isKeeperOnlyPage(page: string): boolean {
  return GUEST_HIDDEN_PAGES.has(page);
}

/**
 * Guest devices only see pages whose tab is switched on.
 * Keeper Mode keeps access so a tab can be switched back on from Settings.
 */
export function pageEnabled(page: string, tabs: EnabledTabs, admin = false): boolean {
  if (admin || KEEPER_PAGES.has(page)) return true;
  const tab = PAGE_TAB[page];
  return tab ? tabs[tab] === 1 : true;
}

/**
 * Overview landing destination for the Guest feedback CTA (“Give us your 2 cents”).
 * Kept as a named page id so landing + nav share PAGE_TAB → whatsnext.
 */
export const LANDING_FEEDBACK_PAGE = "next";

/**
 * Whether the Overview “Give us your 2 cents” CTA may render.
 * Same rule as Guest nav for `next` (PAGE_TAB → whatsnext) — no second flag.
 * Keepers still see it so Settings can re-enable the tab without a dead end.
 */
export function landingFeedbackCtaEnabled(tabs: EnabledTabs, admin = false): boolean {
  return pageEnabled(LANDING_FEEDBACK_PAGE, tabs, admin);
}

/** Position of a page's controlling tab in the keeper's custom order. */
export function tabRank(page: string, order: TabKey[]): number {
  const tab = PAGE_TAB[page];
  const index = tab ? order.indexOf(tab) : -1;
  return index < 0 ? order.length : index;
}

/** Falls back to the first guest-visible page whose tab is switched on, in tab order. */
export function firstEnabledPage(tabs: EnabledTabs, order: TabKey[], candidates: readonly string[]): string {
  return [...candidates]
    .sort((a, b) => tabRank(a, order) - tabRank(b, order))
    .find((page) => pageEnabled(page, tabs)) ?? "dashboard";
}

/**
 * Deterministic primary bottom-nav destinations.
 * Preference tips selection; enabled/ordered collections remain the only source of truth.
 * Never pads with blank slots — returns fewer items when fewer destinations exist.
 */
export function selectPrimaryNav<T extends { id: string }>(
  collectionNav: T[],
  admin: boolean,
  keeperNav: T[],
  capacity = PRIMARY_NAV_CAPACITY
): T[] {
  const preferred = admin ? KEEPER_PRIMARY_PREFERENCE : GUEST_PRIMARY_PREFERENCE;
  const items: T[] = [];
  for (const id of preferred) {
    if (items.length >= capacity) break;
    const fromCollection = collectionNav.find((item) => item.id === id);
    if (fromCollection) {
      items.push(fromCollection);
      continue;
    }
    if (admin) {
      const fromKeeper = keeperNav.find((item) => item.id === id);
      if (fromKeeper) items.push(fromKeeper);
    }
  }
  for (const item of collectionNav) {
    if (items.length >= capacity) break;
    if (items.some((row) => row.id === item.id)) continue;
    items.push(item);
  }
  return items.slice(0, capacity);
}

export function notInPrimaryNav<T extends { id: string }>(items: T[], primary: { id: string }[]): T[] {
  return items.filter((item) => !primary.some((row) => row.id === item.id));
}

/** True when the More affordance should appear (overflow destinations exist). */
export function shouldShowMoreNav(moreCollection: { id: string }[], moreKeeper: { id: string }[]): boolean {
  return moreCollection.length > 0 || moreKeeper.length > 0;
}

/** Every enabled Guest destination is reachable from primary ∪ More with no duplicates. */
export function guestDestinationsCovered(
  collectionNav: { id: string }[],
  primary: { id: string }[],
  moreCollection: { id: string }[]
): { missing: string[]; duplicated: string[] } {
  const primaryIds = primary.map((item) => item.id);
  const moreIds = moreCollection.map((item) => item.id);
  const union = new Set([...primaryIds, ...moreIds]);
  const missing = collectionNav.map((item) => item.id).filter((id) => !union.has(id));
  const duplicated = primaryIds.filter((id) => moreIds.includes(id));
  return { missing, duplicated };
}

/** Filter inventory modules for the Guest/Keeper collection rail. */
export function includeModuleInCollectionNav(moduleId: string, admin: boolean): boolean {
  if (moduleId === "brews") return false; // Homebrew Log lives in Keeper Operations
  if (!admin && GUEST_HIDDEN_PAGES.has(moduleId)) return false;
  return true;
}

/** Stable Keeper Operations order for rail + More. */
export const KEEPER_OPERATION_IDS = [
  "brews",
  "scan",
  "restock",
  "import",
  "messages",
  "settings"
] as const;

export function sortKeeperOperations<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => KEEPER_OPERATION_IDS.indexOf(a.id as typeof KEEPER_OPERATION_IDS[number])
      - KEEPER_OPERATION_IDS.indexOf(b.id as typeof KEEPER_OPERATION_IDS[number])
  );
}

export function mobileShortLabel(id: string, fallback: string): string {
  return MOBILE_SHORT_LABELS[id] ?? fallback;
}
