/**
 * PR153 — Remaining shell and chrome polish.
 * Focused wiring/regression checks for More-sheet close, theme toggle naming,
 * scroll ownership, and unchanged navigation architecture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  guestDestinationsCovered,
  navLabel,
  notInPrimaryNav,
  selectPrimaryNav,
  shouldShowMoreNav
} from "../client/src/shell-nav.ts";
import { cycleTheme, themeToggleLabel } from "../client/src/theme.ts";

const root = join(import.meta.dirname, "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");
const themeSrc = readFileSync(join(root, "client/src/theme.ts"), "utf8");

test("PR153 More sheet exposes an explicit Close control with an accessible name", () => {
  assert.match(appSrc, /className="icon-button more-sheet-close"/);
  assert.match(appSrc, /more-sheet-close[\s\S]*?aria-label="Close more menu"/);
  assert.match(appSrc, /ref=\{moreCloseRef\}/);
  assert.match(cssSrc, /\.more-sheet-close\{[^}]*min-width:\s*44px/);
  assert.match(cssSrc, /\.more-sheet-close\{[^}]*min-height:\s*44px/);
});

test("PR153 More sheet still dismisses via Escape, backdrop, destination, and More toggle", () => {
  assert.match(appSrc, /event\.key === "Escape"\) closeMoreSheet\(\)/);
  assert.match(appSrc, /className=\{moreSheet \? "more-sheet-overlay open" : "more-sheet-overlay"\}/);
  assert.match(appSrc, /onClick=\{closeOverlays\}/);
  // Destination selection still closes the sheet through navigate().
  assert.match(appSrc, /const leavingMore = moreSheet/);
  assert.match(appSrc, /setMoreSheet\(false\)/);
  assert.match(appSrc, /onClick=\{toggleMore\}/);
  assert.match(appSrc, /aria-label=\{moreSheet \? "Close more menu" : "Open more menu"\}/);
});

test("PR153 More dismiss restores focus instead of leaving it stranded", () => {
  assert.match(appSrc, /moreButtonRef\.current\?\.focus\(\)/);
  assert.match(appSrc, /moreCloseRef\.current\?\.focus\(\)/);
  assert.match(appSrc, /main\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
});

test("PR153 theme toggle exposes Switch to Light/Dark action labels", () => {
  assert.match(themeSrc, /export function themeToggleLabel/);
  assert.equal(themeToggleLabel("dark"), "Switch to Light theme");
  assert.equal(themeToggleLabel("light"), "Switch to Dark theme");
  assert.equal(cycleTheme("dark"), "light");
  assert.equal(cycleTheme("light"), "dark");
  assert.match(appSrc, /aria-label=\{themeToggleLabel\(theme\)\}/);
  assert.match(appSrc, /title=\{themeToggleLabel\(theme\)\}/);
  assert.match(appSrc, /onClick=\{\(\) => setTheme\(cycleTheme\(theme\)\)\}/);
  assert.doesNotMatch(appSrc, /aria-label="Change theme"/);
});

test("PR153 rail shell makes main the primary page scroller", () => {
  assert.match(
    cssSrc,
    /@media \(min-width: 1051px\) \{[\s\S]*?main \{[\s\S]*?overflow-y:\s*auto/
  );
  assert.match(
    cssSrc,
    /@media \(min-width: 1051px\) \{[\s\S]*?\.app-shell \{[\s\S]*?overflow:\s*hidden/
  );
  assert.match(
    cssSrc,
    /@media\(max-width:1050px\) and \(orientation:landscape\)\{[\s\S]*?main\{[\s\S]*?overflow-y:auto/
  );
  // Phone portrait keeps document scroll rather than the rail height-lock.
  assert.match(
    cssSrc,
    /@media\(max-width:1050px\) and \(orientation:portrait\)\{[\s\S]*?overflow-y:\s*auto/
  );
  // Rail nav may still scroll when destinations exceed the viewport.
  assert.match(cssSrc, /\.sidebar nav\{[^}]*overflow-y:\s*auto/);
});

test("PR153 does not alter Guest/Keeper navigation coverage or labels", () => {
  const collection = ["dashboard", "taps", "cocktails", "gallery", "events", "spirits", "patrons"].map((id) => ({
    id,
    label: navLabel(id, id)
  }));
  const primary = selectPrimaryNav(collection, false, []);
  const more = notInPrimaryNav(collection, primary);
  assert.equal(shouldShowMoreNav(more, []), true);
  assert.deepEqual(guestDestinationsCovered(collection, primary, more), { missing: [], duplicated: [] });
  assert.equal(navLabel("dashboard", "x"), "Home");
  assert.equal(navLabel("cocktails", "x"), "Drinks");
  assert.equal(navLabel("spirits", "x"), "Spirits");
  assert.equal(navLabel("scan", "x"), "Scan");
  assert.match(appSrc, /Keeper Operations/);
  assert.match(appSrc, /data-mode=\{admin \? "keeper" : "guest"\}/);
  assert.match(appSrc, /data-shell=\{phoneShell \? "phone" : "rail"\}/);
});
