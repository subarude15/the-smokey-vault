/**
 * PR159 — Homepage Brand Hero & Filigree Refinement.
 *
 * Structural regression coverage (source-reading, like pr151-bottle-library-media.test.ts):
 * the guest greeting is a plain time-of-day eyebrow, the Dashboard hero uses the
 * traced-vector wordmark + decorative hop-vine filigree (no duplicate medallion,
 * no orbit ornament), the header keeps the single SB medallion, "Patron / Lounge"
 * language is gone, and the vector components are genuine <path> art (no <text>,
 * no embedded raster). We deliberately do NOT assert exact path coordinates.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { overviewGreeting } from "./overview.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const appSrc = read("client/src/App.tsx");
const cssSrc = read("client/src/styles.css") + read("client/src/home-hero.css");
const wordmarkSrc = read("client/src/SmokeyBarrelWordmark.tsx");
const filigreeSrc = read("client/src/HopFiligree.tsx");

test("guest greeting has no Patron / Lounge language, any hour", () => {
  for (const hour of [8, 13, 19, 23, 2]) {
    const guest = overviewGreeting(new Date(2026, 7, 21, hour, 0, 0), true);
    assert.doesNotMatch(guest.eyebrow, /PATRON|LOUNGE/i);
  }
  // The plain time-of-day eyebrow is preserved for guests.
  assert.equal(overviewGreeting(new Date(2026, 7, 21, 13, 0, 0), true).eyebrow, "GOOD AFTERNOON");
});

test("hero drops the duplicate medallion and the orbit ornament", () => {
  assert.doesNotMatch(appSrc, /hero-brand/);
  assert.doesNotMatch(appSrc, /hero-orbit/);
  assert.doesNotMatch(cssSrc, /hero-orbit|hero-brand|orbit-glow/);
});

test("the single SB medallion still anchors the header/shell", () => {
  // Shell brand + phone topbar keep the shared SbMark component.
  assert.match(appSrc, /<SbMark className="brand-mark"/);
  assert.match(appSrc, /<SbMark className="topbar-brand"/);
});

test("Dashboard renders the traced wordmark and decorative filigree", () => {
  assert.match(appSrc, /import \{ SmokeyBarrelWordmark \} from ".\/SmokeyBarrelWordmark"/);
  assert.match(appSrc, /import \{ HopFiligree \} from ".\/HopFiligree"/);
  assert.match(appSrc, /<SmokeyBarrelWordmark\s*\/>/);
  assert.match(appSrc, /<HopFiligree className="hero-filigree"\s*\/>/);
});

test("the wordmark stays an accessible level-1 heading", () => {
  // The visible artwork is SVG, but the name is still exposed as an h1-level heading.
  assert.match(
    appSrc,
    /className="hero-wordmark"[^>]*role="heading"[^>]*aria-level=\{1\}[\s\S]*?<SmokeyBarrelWordmark/,
  );
  // ...and the SVG itself carries the accessible name.
  assert.match(wordmarkSrc, /role="img"/);
  assert.match(wordmarkSrc, /aria-label="The Smokey Barrel"/);
});

test("the filigree is purely decorative and non-interactive", () => {
  assert.match(filigreeSrc, /aria-hidden="true"/);
  // Never focusable, never a pointer target.
  assert.match(filigreeSrc, /focusable=\{false\}/);
  assert.match(cssSrc, /\.hero-filigree\{[^}]*pointer-events:none/);
  // The hero clips the trailing vine so it can never cause horizontal overflow.
  assert.match(cssSrc, /\.hero\{[^}]*overflow:hidden/);
});

test("copy no longer says Patron and unlock reads as Keeper Mode / Tap to unlock", () => {
  assert.doesNotMatch(appSrc, /Welcome, Patron/);
  assert.doesNotMatch(appSrc, /PATRON MODE/);
  assert.doesNotMatch(appSrc, /PATRON LOUNGE/);
  assert.doesNotMatch(appSrc, /Tap for Keeper Mode/);
  assert.match(appSrc, /Tap to unlock/);
  assert.match(appSrc, /<strong>Keeper Mode<\/strong>/);
});

test("wordmark remains genuine vector paths, not text or raster", () => {
  for (const src of [wordmarkSrc]) {
    assert.doesNotMatch(src, /<text[\s>]/); // no SVG <text> glyphs
    assert.doesNotMatch(src, /data:image|base64/); // no embedded raster
    assert.match(src, /<path\b/); // real path geometry
    assert.match(src, /viewBox="/);
  }
  // The wordmark keeps the two independently themed fills (copper THE + text body).
  assert.match(wordmarkSrc, /fill="currentColor"/);
  assert.match(wordmarkSrc, /var\(--accent\)/);
});

test("corner is a continuous responsive vector treatment", () => {
  assert.match(filigreeSrc, /fillRule="evenodd"/);
  assert.match(filigreeSrc, /preserveAspectRatio="xMaxYMin meet"/);
  assert.doesNotMatch(filigreeSrc, /<image|\.png|\.jpe?g/);
  assert.match(cssSrc, /\.hero \.hero-greeting em\{display:block\}/);
  assert.match(cssSrc, /linear-gradient\(#000 65%,transparent 100%\)/);
});

test("filigree color and mobile bounds come from theme tokens / responsive CSS", () => {
  // Charcoal/gunmetal (Dark) and muted neutral (Light) via the shared --line token.
  assert.match(cssSrc, /\.hero-filigree\{[^}]*var\(--line\)/);
  // Bounded on the narrow phone breakpoint so it stays restrained.
  assert.match(cssSrc, /@media\(max-width:360px\)\{[\s\S]*?\.hero-filigree\{/);
});
