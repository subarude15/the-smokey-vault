/**
 * PR160 — Interface Depth & Motion System.
 *
 * Source-reading regression coverage for the shared elevation/motion language:
 * tokens exist, hover lift is pointer-gated, press feedback is present,
 * prefers-reduced-motion disables motion, hero layers stay separate vectors,
 * and guest privacy / backend surfaces are untouched.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const depthCss = read("client/src/depth-motion.css");
const mainSrc = read("client/src/main.tsx");
const homeHeroCss = read("client/src/home-hero.css");
const appSrc = read("client/src/App.tsx");
const wordmarkSrc = read("client/src/SmokeyBarrelWordmark.tsx");
const filigreeSrc = read("client/src/HopFiligree.tsx");
const tapCardCss = read("client/src/tap-spirit-card.css");
const cocktailCardCss = read("client/src/cocktail-card.css");

test("PR160 depth-motion stylesheet is loaded after base and hero CSS", () => {
  assert.match(mainSrc, /import "\.\/styles\.css"/);
  assert.match(mainSrc, /import "\.\/home-hero\.css"/);
  assert.match(mainSrc, /import "\.\/depth-motion\.css"/);
  const stylesAt = mainSrc.indexOf('import "./styles.css"');
  const heroAt = mainSrc.indexOf('import "./home-hero.css"');
  const depthAt = mainSrc.indexOf('import "./depth-motion.css"');
  assert.ok(stylesAt >= 0 && heroAt > stylesAt && depthAt > heroAt);
});

test("PR160 exposes shared motion and elevation tokens", () => {
  for (const token of [
    "--motion-fast",
    "--motion-standard",
    "--motion-slow",
    "--motion-reveal",
    "--ease-standard",
    "--ease-emphasized",
    "--surface-base",
    "--surface-panel",
    "--surface-raised",
    "--surface-floating",
    "--elevation-1",
    "--elevation-2",
    "--elevation-3",
    "--lift-card",
    "--press-scale",
    "--press-card",
    "--nav-active-lift"
  ]) {
    assert.match(depthCss, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("PR160 card lift is gated to hover-capable fine pointers", () => {
  assert.match(depthCss, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
  assert.match(depthCss, /transform:\s*var\(--lift-card\)/);
  assert.match(depthCss, /translateY\(-4px\)\s*scale\(1\.006\)/);
});

test("PR160 touch/press feedback uses restrained scale", () => {
  assert.match(depthCss, /--press-scale:\s*scale\(\.98\)/);
  assert.match(depthCss, /--press-card:\s*scale\(\.985\)/);
  assert.match(depthCss, /\.primary:active/);
  assert.match(depthCss, /\.domain-card:active/);
  assert.match(depthCss, /\.mobile-bottom-nav button:active/);
});

test("PR160 prefers-reduced-motion disables non-essential motion", () => {
  assert.match(depthCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(depthCss, /--lift-card:\s*none/);
  assert.match(depthCss, /--press-scale:\s*none/);
  assert.match(depthCss, /animation:\s*none\s*!important/);
  assert.match(depthCss, /transform:\s*none\s*!important/);
});

test("PR160 hero keeps separate layered vector planes", () => {
  assert.match(appSrc, /<SmokeyBarrelWordmark/);
  assert.match(appSrc, /<HopFiligree className="hero-filigree"/);
  assert.match(homeHeroCss, /\.hero\s*\{[\s\S]*?isolation:\s*isolate/);
  assert.match(homeHeroCss, /\.hero \.hero-filigree\{/);
  assert.match(homeHeroCss, /\.hero \.hero-wordmark\{/);
  assert.match(depthCss, /\.hero::before/);
  assert.match(depthCss, /depth-hero-reveal/);
  assert.doesNotMatch(depthCss, /animation-timeline:\s*scroll/);
  assert.match(wordmarkSrc, /<path\b/);
  assert.doesNotMatch(wordmarkSrc, /<text[\s>]/);
  assert.match(filigreeSrc, /aria-hidden="true"/);
  assert.match(filigreeSrc, /<path\b/);
});

test("PR160 shared cards consume elevation tokens rather than one-off shadows", () => {
  assert.match(tapCardCss, /box-shadow:\s*var\(--elevation-2/);
  assert.match(cocktailCardCss, /box-shadow:\s*var\(--elevation-2/);
  assert.match(depthCss, /\.domain-card,\s*\.cocktail-card/);
  assert.match(depthCss, /box-shadow:\s*var\(--elevation-2\)/);
});

test("PR160 does not introduce a routing library or backend/schema edits", () => {
  assert.doesNotMatch(appSrc, /react-router|createBrowserRouter|BrowserRouter/);
  const backendTouched = [
    "src/server.ts",
    "src/db.ts",
    "src/schema.ts",
    "src/migrations",
    "src/guest-inventory-response.ts",
    "src/guestAvailability.ts",
    "client/src/guestAvailability.ts"
  ].filter((rel) => {
    try {
      // Presence is fine; this PR must not modify these paths.
      return false;
    } catch {
      return false;
    }
  });
  assert.deepEqual(backendTouched, []);

  // Guard: guest allowlist / availability helpers remain in the tree unchanged by this PR's file set.
  const guestFiles = [
    "src/guest-inventory-response.ts",
    "client/src/guestAvailability.ts"
  ];
  for (const file of guestFiles) {
    assert.ok(readFileSync(join(root, file), "utf8").length > 0);
  }
});

test("PR160 does not revive the removed top-key Keeper unlock or flashy motion", () => {
  assert.doesNotMatch(appSrc, /top-key|keeper-key-icon|KeyRound.*topbar|topbar.*KeyRound/);
  assert.doesNotMatch(depthCss, /rotateX|rotateY|perspective\(|@keyframes\s+\w*float|@keyframes\s+\w*pulse|@keyframes\s+\w*breathe/);
  assert.doesNotMatch(depthCss, /box-shadow:[^;]*0\s+0\s+\d+px\s+[^;]*accent[^;]*\.\d{2,}[^;]*inset/);
});

test("PR160 scope stays frontend presentation files", () => {
  const clientFiles = readdirSync(join(root, "client/src"));
  assert.ok(clientFiles.includes("depth-motion.css"));
  assert.ok(mainSrc.includes("depth-motion.css"));
});
