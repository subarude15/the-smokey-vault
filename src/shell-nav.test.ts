/**
 * PR134 — responsive shell navigation helpers and wiring regressions.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENABLED_TABS, type EnabledTabs, type TabKey } from "../client/src/catalog.ts";
import {
  GUEST_HIDDEN_PAGES,
  GUEST_LANDING_CANDIDATES,
  GUEST_PRIMARY_PREFERENCE,
  KEEPER_OPERATION_IDS,
  KEEPER_PAGES,
  KEEPER_PRIMARY_PREFERENCE,
  PRIMARY_NAV_CAPACITY,
  firstEnabledPage,
  guestDestinationsCovered,
  includeModuleInCollectionNav,
  isKeeperOnlyPage,
  notInPrimaryNav,
  pageEnabled,
  selectPrimaryNav,
  shouldShowMoreNav,
  sortKeeperOperations,
  tabRank
} from "../client/src/shell-nav.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");
const shellSrc = readFileSync(join(root, "client/src/shell-nav.ts"), "utf8");
const apiSrc = readFileSync(join(root, "client/src/api.ts"), "utf8");
const bottleNavSrc = readFileSync(join(root, "client/src/bottle-detail-nav.ts"), "utf8");

function tabs(overrides: Partial<EnabledTabs> = {}): EnabledTabs {
  return { ...DEFAULT_ENABLED_TABS, ...overrides };
}

function nav(ids: string[]) {
  return ids.map((id) => ({ id, label: id }));
}

test("disabled Guest tab disappears from enabled nav selection", () => {
  const all = tabs();
  assert.equal(pageEnabled("gallery", all, false), true);
  assert.equal(pageEnabled("gallery", tabs({ gallery: 0 }), false), false);
  assert.equal(pageEnabled("gallery", tabs({ gallery: 0 }), true), true);
});

test("re-enabled Guest tab returns and order follows tabOrder", () => {
  const order: TabKey[] = ["gallery", "overview", "cocktails", "cellar", "brewery", "patrons", "staff", "events", "tipjar", "merch", "whatsnext"];
  const disabled = tabs({ gallery: 0 });
  assert.notEqual(firstEnabledPage(disabled, order, GUEST_LANDING_CANDIDATES), "gallery");
  const enabled = tabs({ gallery: 1 });
  assert.equal(firstEnabledPage(enabled, order, ["gallery", "dashboard"]), "gallery");
  assert.ok(tabRank("gallery", order) < tabRank("dashboard", order));
});

test("primary nav has no blank slots when a preferred tab is disabled", () => {
  const collection = nav(["dashboard", "taps", "spirits", "events"]);
  const primary = selectPrimaryNav(collection, false, [], 4);
  assert.deepEqual(primary.map((item) => item.id), ["dashboard", "taps", "spirits", "events"]);
  assert.equal(primary.length, 4);
  assert.equal(primary.some((item) => !item), false);
});

test("primary nav is deterministic and prefers high-value Guest destinations", () => {
  const collection = nav([
    "spirits", "dashboard", "events", "taps", "cocktails", "gallery", "patrons"
  ]);
  const primary = selectPrimaryNav(collection, false, [], PRIMARY_NAV_CAPACITY);
  assert.deepEqual(primary.map((item) => item.id), [...GUEST_PRIMARY_PREFERENCE]);
  assert.deepEqual(
    selectPrimaryNav(collection, false, [], PRIMARY_NAV_CAPACITY).map((item) => item.id),
    primary.map((item) => item.id)
  );
});

test("remaining Guest tabs appear in More with no duplicates; full coverage", () => {
  const collection = nav([
    "dashboard", "taps", "cocktails", "gallery", "events", "patrons", "spirits", "brewery"
  ]);
  const primary = selectPrimaryNav(collection, false, []);
  const more = notInPrimaryNav(collection, primary);
  const { missing, duplicated } = guestDestinationsCovered(collection, primary, more);
  assert.deepEqual(missing, []);
  assert.deepEqual(duplicated, []);
  assert.equal(shouldShowMoreNav(more, []), true);
  assert.equal(primary.length + more.length, collection.length);
});

test("Guest Mode excludes Keeper-only operations; brewery stays Guest-capable", () => {
  for (const id of ["scan", "import", "restock", "settings", "messages", "brews"]) {
    assert.equal(isKeeperOnlyPage(id), true);
    assert.equal(GUEST_HIDDEN_PAGES.has(id), true);
  }
  assert.equal(isKeeperOnlyPage("brewery"), false);
  assert.equal(includeModuleInCollectionNav("brews", false), false);
  assert.equal(includeModuleInCollectionNav("brews", true), false);
  assert.equal(includeModuleInCollectionNav("taps", false), true);
  assert.equal(pageEnabled("brewery", tabs(), false), true);
});

test("Keeper Operations order includes Homebrew Log and unread-capable messages", () => {
  const ops = sortKeeperOperations(nav(["settings", "messages", "brews", "scan", "import", "restock"]));
  assert.deepEqual(ops.map((item) => item.id), [...KEEPER_OPERATION_IDS]);
  assert.ok(KEEPER_OPERATION_IDS.includes("brews"));
  assert.ok(KEEPER_OPERATION_IDS.includes("messages"));
  assert.ok(KEEPER_PAGES.has("messages"));
});

test("Keeper primary may include Scan without crowding Guest preferences for guests", () => {
  const collection = nav(["dashboard", "taps", "cocktails", "gallery"]);
  const keeper = nav(["scan", "messages", "settings"]);
  const guestPrimary = selectPrimaryNav(collection, false, keeper);
  assert.equal(guestPrimary.some((item) => item.id === "scan"), false);
  const keeperPrimary = selectPrimaryNav(collection, true, keeper);
  assert.deepEqual(keeperPrimary.map((item) => item.id).slice(0, 2), ["dashboard", "scan"]);
  assert.ok(KEEPER_PRIMARY_PREFERENCE.includes("scan"));
});

test("App wires shell helpers, handToGuest, and PR133 auth rejection", () => {
  assert.match(appSrc, /from \"\.\/shell-nav\"/);
  assert.match(appSrc, /selectPrimaryNav\(/);
  assert.match(appSrc, /shouldShowMoreNav\(/);
  assert.match(appSrc, /data-mode=\{admin \? \"keeper\" : \"guest\"\}/);
  assert.match(appSrc, /data-shell=\{phoneShell \? \"phone\" : \"rail\"\}/);
  assert.match(appSrc, /Keeper Operations/);
  assert.match(appSrc, /id:\"brews\",label:\"Homebrew Log\"/);
  assert.match(appSrc, /handToGuest\(\)/);
  assert.match(appSrc, /useEffect\(\(\) => onKeeperAuthRejected\(handToGuest\),\s*\[handToGuest\]\)/);
  assert.match(appSrc, /setTimeout\(handToGuest,\s*KIOSK_IDLE_MS\)/);
  assert.match(appSrc, /onClick=\{handToGuest\}/);
  assert.match(appSrc, /admin \? handToGuest\(\)/);
  assert.doesNotMatch(appSrc, /\block\s*=\s*useCallback/);
  assert.match(apiSrc, /keeperAuthRejectedPending/);
});

test("phone bottom-nav and safe-area CSS; rail for landscape/desktop", () => {
  assert.match(appSrc, /className=\"mobile-bottom-nav\"/);
  assert.match(cssSrc, /safe-area-inset-bottom/);
  assert.match(cssSrc, /\.mobile-bottom-nav\{[^}]*display:\s*flex/);
  assert.match(cssSrc, /\.mobile-bottom-nav button\{[^}]*min-height:\s*48px/);
  assert.match(
    cssSrc,
    /@media\(max-width:1050px\) and \(orientation:portrait\)\{[\s\S]*?\.sidebar\{display:none!important\}/
  );
  assert.match(
    cssSrc,
    /@media\(max-width:1050px\) and \(orientation:landscape\)\{[\s\S]*?grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)/
  );
  assert.match(cssSrc, /\.app-shell\{[^}]*grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)/);
  assert.match(appSrc, /phoneShell && <nav className=\"mobile-bottom-nav\"/);
});

test("event deep-link, mixologist legacy, and bottle-detail helpers remain intact", () => {
  assert.match(appSrc, /parseEventIdFromSearch/);
  assert.match(appSrc, /syncEventDeepLinkUrl/);
  assert.match(appSrc, /page !== \"mixologist\"/);
  assert.match(appSrc, /setPage\(\"cocktails\"\)/);
  assert.match(appSrc, /focusMixologist/);
  assert.match(bottleNavSrc, /resolveDetailBackTarget/);
  assert.match(bottleNavSrc, /pushBottleDetailHistory/);
  assert.match(shellSrc, /GUEST_HIDDEN_PAGES/);
});

test("single page content tree — no mobile/desktop page fork", () => {
  assert.equal((appSrc.match(/\{page === \"dashboard\" && <Dashboard/g) ?? []).length, 1);
  assert.equal((appSrc.match(/\{page === \"cocktails\" && <Cocktails/g) ?? []).length, 1);
  assert.doesNotMatch(appSrc, /phoneShell\s*\?\s*<Dashboard/);
  assert.doesNotMatch(appSrc, /compactNav\s*\?\s*<Cocktails/);
});
