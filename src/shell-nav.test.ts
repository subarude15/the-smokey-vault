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
  DESTINATION_TITLES,
  GUEST_HIDDEN_PAGES,
  GUEST_LANDING_CANDIDATES,
  GUEST_PRIMARY_PREFERENCE,
  KEEPER_OPERATION_IDS,
  KEEPER_PAGES,
  KEEPER_PRIMARY_PREFERENCE,
  NAV_LABELS,
  PRIMARY_NAV_CAPACITY,
  destinationTitle,
  firstEnabledPage,
  guestDestinationsCovered,
  includeModuleInCollectionNav,
  isKeeperOnlyPage,
  LANDING_FEEDBACK_PAGE,
  landingFeedbackCtaEnabled,
  navLabel,
  notInPrimaryNav,
  pageEnabled,
  selectPrimaryNav,
  shouldShowMoreNav,
  sortKeeperOperations,
  tabRank
} from "../client/src/shell-nav.ts";
import { MISSING_ONE_HINT } from "../client/src/cocktail-card.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");
const shellSrc = readFileSync(join(root, "client/src/shell-nav.ts"), "utf8");
const apiSrc = readFileSync(join(root, "client/src/api.ts"), "utf8");
const bottleNavSrc = readFileSync(join(root, "client/src/bottle-detail-nav.ts"), "utf8");
const tipJarSrc = readFileSync(join(root, "client/src/TipJarPage.tsx"), "utf8");
const breweryLabDetailSrc = readFileSync(join(root, "client/src/BreweryLabDetail.tsx"), "utf8");

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

test("Give us your 2 cents landing CTA follows whatsnext via pageEnabled", () => {
  assert.equal(LANDING_FEEDBACK_PAGE, "next");
  assert.equal(pageEnabled("next", tabs(), false), true);
  assert.equal(landingFeedbackCtaEnabled(tabs(), false), true);

  const disabled = tabs({ whatsnext: 0 });
  assert.equal(pageEnabled("next", disabled, false), false);
  assert.equal(landingFeedbackCtaEnabled(disabled, false), false);
  // Same source of truth — CTA helper must not drift from nav visibility.
  assert.equal(landingFeedbackCtaEnabled(disabled, false), pageEnabled("next", disabled, false));

  assert.equal(pageEnabled("next", tabs({ whatsnext: 1 }), false), true);
  assert.equal(landingFeedbackCtaEnabled(tabs({ whatsnext: 1 }), false), true);

  // Keepers still reach feedback / Settings re-enable path.
  assert.equal(pageEnabled("next", disabled, true), true);
  assert.equal(landingFeedbackCtaEnabled(disabled, true), true);
});

test("Overview wires landing feedback CTA through shared helper", () => {
  assert.match(shellSrc, /LANDING_FEEDBACK_PAGE\s*=\s*\"next\"/);
  assert.match(shellSrc, /landingFeedbackCtaEnabled/);
  assert.match(shellSrc, /pageEnabled\(LANDING_FEEDBACK_PAGE/);
  assert.match(appSrc, /landingFeedbackCtaEnabled\(enabledTabs,\s*admin\)/);
  assert.match(appSrc, /Give us your 2 cents/);
  // No parallel feature flag for the landing CTA.
  assert.doesNotMatch(appSrc, /showFeedbackCard|showTwoCents|feedbackEnabled/);
  assert.doesNotMatch(shellSrc, /showFeedbackCard|showTwoCents|feedbackEnabled/);
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

test("PR148 keeps Keeper entry in navigation, not the Guest topbar", () => {
  assert.doesNotMatch(appSrc, /!admin\s*&&\s*<button[^>]+aria-label="Enter Keeper PIN"/);
  assert.match(appSrc, /admin \? handToGuest\(\) : setUnlock\(true\)/);
  assert.match(appSrc, /Tap for Keeper Mode/);
  assert.match(appSrc, /aria-label="Change theme"/);
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
  // Main (not only .page) carries phone clearance so GuestFooter after .page stays usable.
  assert.match(cssSrc, /--mobile-bottom-nav-clearance:\s*calc\(66px\s*\+\s*env\(safe-area-inset-bottom\)\)/);
  assert.match(cssSrc, /main\.has-mobile-nav\{[^}]*padding-bottom:\s*var\(--mobile-bottom-nav-clearance\)/);
  assert.doesNotMatch(cssSrc, /\.has-mobile-nav \.page\{[^}]*padding-bottom:\s*calc\(88px/);
  assert.doesNotMatch(cssSrc, /\.has-mobile-nav \.guest-footer\{[^}]*margin-bottom/);
  assert.match(cssSrc, /@media\(hover:none\)\{\.card-actions\{opacity:1\}\}/);
  assert.match(cssSrc, /\.toast\{bottom:calc\(var\(--mobile-bottom-nav-clearance\) \+ 12px\)\}/);
});

test("PR148 uses Guest and Keeper terminology in user-facing copy", () => {
  assert.doesNotMatch(appSrc, /Unlock Admin Mode|Admin unlock required|Patron Mode uses/);
  assert.doesNotMatch(tipJarSrc, /Admin → Settings/);
  assert.match(tipJarSrc, /Keeper Mode → Settings/);
});

test("More hint only renders when More overflow exists", () => {
  assert.match(appSrc, /navHint && phoneShell && showMoreNav/);
  assert.match(appSrc, /showMoreNav && <button/);
  const withOverflow = nav(["dashboard", "taps", "cocktails", "gallery", "events", "patrons"]);
  const primary = selectPrimaryNav(withOverflow, false, []);
  const more = notInPrimaryNav(withOverflow, primary);
  assert.equal(shouldShowMoreNav(more, []), true);
  const tight = nav(["dashboard", "taps", "cocktails", "gallery"]);
  const tightPrimary = selectPrimaryNav(tight, false, []);
  const tightMore = notInPrimaryNav(tight, tightPrimary);
  assert.equal(shouldShowMoreNav(tightMore, []), false);
  assert.equal(tightPrimary.length, 4);
  assert.equal(tightMore.length, 0);
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

/* ---------------------- PR149 — nav labels & terminology ------------------- */

test("PR149 nav labels resolve deterministically to the intended shorthands", () => {
  assert.equal(navLabel("dashboard", "x"), "Home");
  assert.equal(navLabel("taps", "x"), "On Tap");
  assert.equal(navLabel("cocktails", "x"), "Drinks");
  assert.equal(navLabel("gallery", "x"), "Gallery");
  assert.equal(navLabel("spirits", "x"), "Spirits");
  assert.equal(navLabel("wines", "x"), "Wine");
  assert.equal(navLabel("packaged_beer", "x"), "Beer");
  // Unknown ids fall back to the provided label, never throw.
  assert.equal(navLabel("not-a-page", "Fallback"), "Fallback");
});

test("PR149 destination titles pair concise nav labels with fuller headings", () => {
  // Where a distinction improves clarity, the heading differs from the nav label.
  assert.equal(destinationTitle("cocktails", "x"), "What can I make?");
  assert.notEqual(destinationTitle("cocktails", "x"), navLabel("cocktails", "x"));
  assert.equal(destinationTitle("spirits", "x"), "The Bottle Library");
  assert.notEqual(destinationTitle("spirits", "x"), navLabel("spirits", "x"));
  // Destinations whose label already reads as the heading reuse the nav label.
  assert.equal(destinationTitle("gallery", "Gallery"), "Gallery");
  assert.equal(destinationTitle("taps", "x"), "On Tap");
  assert.equal(destinationTitle("taps", "x"), navLabel("taps", "x"));
  // Unknown ids fall back to the provided fallback.
  assert.equal(destinationTitle("not-a-page", "Fallback"), "Fallback");
});

test("PR149 destination titles agree with the inventory module page titles", () => {
  // The label map is the single source of truth: module `title` strings in App
  // must not drift from DESTINATION_TITLES.
  for (const [id, title] of [
    ["spirits", "The Bottle Library"],
    ["wines", "The Wine Cellar"],
    ["packaged_beer", "Packaged Beer"],
    ["taps", "On Tap"]
  ] as const) {
    assert.equal(DESTINATION_TITLES[id], title);
    assert.match(appSrc, new RegExp(`id: ?"${id}"[^]*?title: ?"${title}"`));
  }
});

test("PR149 all shell surfaces render the shared nav label (no drift)", () => {
  // Rail, More sheet, phone bottom bar, and topbar title all resolve via navLabel.
  assert.match(appSrc, /<item\.icon size=\{19\}\/>\{navLabel\(item\.id, item\.label\)\}/); // rail + More
  assert.match(appSrc, /<span>\{navLabel\(item\.id, item\.label\)\}<\/span>/); // phone bottom bar
  assert.match(appSrc, /const pageTitle = navLabel\(page,/); // topbar title
  // The old phone-only helper name is fully retired.
  assert.doesNotMatch(appSrc, /mobileShortLabel/);
  assert.doesNotMatch(shellSrc, /mobileShortLabel|MOBILE_SHORT_LABELS/);
});

test("PR149 Cocktails heading uses the destination-title source of truth", () => {
  assert.match(appSrc, /title=\{destinationTitle\("cocktails", "What can I make\?"\)\}/);
});

test("PR149 clarifies Missing one without changing filter/count semantics", () => {
  assert.equal(MISSING_ONE_HINT, "One ingredient away from making.");
  // The three cocktail filter ids and their order are unchanged.
  assert.match(
    appSrc,
    /\[\["ready", admin \? "Ready now" : "Off the menu"\], \["almost", "Missing one"\], \["all", "All recipes"\]\]/
  );
  // The hint is surfaced accessibly (tab aria-label/title) and as a visible helper.
  assert.match(appSrc, /aria-label=\{id === "almost" \? `\$\{label\} — \$\{MISSING_ONE_HINT\}`/);
  assert.match(appSrc, /filter === "almost" && <p className="cocktail-filter-hint"/);
});

test("PR149 Guest-facing Smokey Vault copy becomes Smokey Barrel", () => {
  // The one Guest-visible brand string in the Brewery Lab editor is rebranded.
  assert.doesNotMatch(breweryLabDetailSrc, /Smokey Vault/);
  assert.match(breweryLabDetailSrc, /These fields stay in The Smokey Barrel\./);
});
