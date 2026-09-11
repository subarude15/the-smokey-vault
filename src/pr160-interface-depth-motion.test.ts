/**
 * PR160 — Interface Depth & Motion System.
 *
 * Source-reading regression coverage for the shared elevation/motion language:
 * stronger resting Depth-2 elevation, unmistakable hover lift, Depth 0–4 planes,
 * pointer-gated hover, press feedback, prefers-reduced-motion (motion only),
 * hero layers stay separate vectors, guest privacy / backend untouched.
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

test("PR160 exposes shared motion, surface, and elevation tokens through Depth 4", () => {
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
    "--elevation-4",
    "--edge-highlight",
    "--lift-card",
    "--press-scale",
    "--press-card",
    "--nav-active-lift"
  ]) {
    assert.match(depthCss, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("PR160 resting Depth-2 elevation uses real dark contrast plus edge lighting", () => {
  assert.match(depthCss, /--elevation-2:[\s\S]*?#000/);
  assert.match(depthCss, /--elevation-2:[\s\S]*?var\(--edge-card\)|--elevation-2:[\s\S]*?var\(--edge-highlight\)/);
  assert.match(depthCss, /--edge-highlight:\s*inset/);
  assert.match(depthCss, /--edge-shadow:\s*inset/);
  // Warm bounce-light stays atmospheric (single-digit / low alpha), not a glow border.
  assert.match(depthCss, /--elevation-2:[\s\S]*?var\(--accent\)/);
  assert.doesNotMatch(depthCss, /box-shadow:[^;]*0\s+0\s+\d{2,}px\s+[^;]*accent[^;]*\.\d{2,}/);
});

test("PR160 card lift is gated to hover-capable fine pointers and is visually clear", () => {
  assert.match(depthCss, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
  assert.match(depthCss, /transform:\s*var\(--lift-card\)/);
  assert.match(depthCss, /--lift-card:\s*translateY\(-8px\)\s*scale\(1\.012\)/);
  assert.match(depthCss, /--lift-card-strong:\s*translateY\(-9px\)\s*scale\(1\.015\)/);
  assert.match(depthCss, /box-shadow:\s*var\(--elevation-3\)/);
});

test("PR160 guest-facing card surfaces receive Depth-2 elevation", () => {
  for (const selector of [
    ".domain-card",
    ".cocktail-card",
    ".stat-card",
    ".feature-card",
    ".event-card",
    ".merch-card",
    ".gallery-album-card",
    ".lab-card",
    ".lab-card-button",
    ".inventory-card",
    ".inventory-card-button",
    ".overview-tap",
    ".overview-brew",
    ".overview-low"
  ]) {
    assert.match(depthCss, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(depthCss, /box-shadow:\s*var\(--elevation-2\)/);
  assert.match(tapCardCss, /box-shadow:\s*var\(--elevation-2/);
  assert.match(cocktailCardCss, /box-shadow:\s*var\(--elevation-2/);
});

test("PR160 overlays use Depth-4 elevation distinct from hovered cards", () => {
  assert.match(depthCss, /\.modal[\s\S]*?box-shadow:\s*var\(--elevation-4\)/);
  assert.match(depthCss, /\.more-sheet\.open[\s\S]*?box-shadow:\s*var\(--elevation-4\)/);
  assert.match(depthCss, /\.lightbox-stage[\s\S]*?box-shadow:\s*var\(--elevation-4\)/);
});

test("PR160 touch/press feedback uses restrained inward scale", () => {
  assert.match(depthCss, /--press-scale:\s*scale\(\.975\)/);
  assert.match(depthCss, /--press-card:\s*scale\(\.978\)/);
  assert.match(depthCss, /\.primary:active/);
  assert.match(depthCss, /\.domain-card:active/);
  assert.match(depthCss, /\.mobile-bottom-nav button:active/);
});

test("PR160 prefers-reduced-motion disables movement but keeps static elevation tokens", () => {
  assert.match(depthCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(depthCss, /--lift-card:\s*none/);
  assert.match(depthCss, /--press-scale:\s*none/);
  assert.match(depthCss, /animation:\s*none\s*!important/);
  assert.match(depthCss, /transform:\s*none\s*!important/);
  // Static depth remains defined — reduced motion must not zero elevation tokens.
  assert.doesNotMatch(
    depthCss,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\{[^}]*--elevation-2:\s*none/
  );
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

test("PR160 homepage uses CSS sticky hero underlap with foreground scrim", () => {
  // Layered planes: sticky back-plane hero + raised content, no JS scroll wiring.
  assert.match(appSrc, /className="home-stack"/);
  assert.match(appSrc, /className="home-opening"/);
  assert.match(appSrc, /className="home-hero-pin"/);
  assert.match(appSrc, /className="home-content"/);
  assert.match(depthCss, /\.home-hero-pin\{[\s\S]*?position:\s*sticky/);
  assert.match(depthCss, /\.home-opening\{[\s\S]*?min-height:/);
  assert.match(depthCss, /\.home-content\{[\s\S]*?z-index:\s*2/);
  assert.match(depthCss, /\.home-content\{[\s\S]*?background:\s*var\(--surface-base\)/);
  assert.match(depthCss, /\.home-content::before\{/);
  assert.match(depthCss, /linear-gradient\(/);
  assert.match(depthCss, /\[data-theme="dark"\]\s*\.home-content::before/);
  assert.match(depthCss, /\[data-theme="light"\]\s*\.home-content::before/);
  // Sticky must not be poisoned by a transform on the homepage wrapper.
  assert.match(depthCss, /\.page\s*>\s*\*:[^\n]*:not\(\.home-stack\)/);
  assert.match(depthCss, /@keyframes\s+depth-home-stack-enter/);
  assert.doesNotMatch(depthCss, /addEventListener\(\s*["']scroll["']/);
  assert.doesNotMatch(depthCss, /animation-timeline:\s*scroll/);
  // Short viewports fall back so sticky never traps scroll.
  assert.match(depthCss, /@media\s*\(max-height:\s*520px\)[\s\S]*?\.home-hero-pin\{[\s\S]*?position:\s*relative/);
});

test("PR160 does not introduce a routing library or backend/schema edits", () => {
  assert.doesNotMatch(appSrc, /react-router|createBrowserRouter|BrowserRouter/);
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
});

test("PR160 scope stays frontend presentation files", () => {
  const clientFiles = readdirSync(join(root, "client/src"));
  assert.ok(clientFiles.includes("depth-motion.css"));
  assert.ok(mainSrc.includes("depth-motion.css"));
});
