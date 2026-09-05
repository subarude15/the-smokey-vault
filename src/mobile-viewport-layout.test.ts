/**
 * PR #92 — mobile viewport / overflow harden source guards.
 * Layout-only: no navigation, data, enrichment, or API changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlSrc = readFileSync(join(root, "client/index.html"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");

function viewportMeta(): string {
  const match = htmlSrc.match(/<meta\s+name="viewport"\s+content="([^"]+)"\s*\/?>/i);
  assert.ok(match, "viewport meta tag must exist");
  return match[1];
}

test("A. viewport meta uses device-width without disabling zoom", () => {
  const content = viewportMeta();
  assert.match(content, /width=device-width/);
  assert.match(content, /initial-scale=1/);
  assert.match(content, /viewport-fit=cover/);
  assert.doesNotMatch(content, /maximum-scale\s*=/);
  assert.doesNotMatch(content, /user-scalable\s*=\s*no/i);
});

test("H. no user-scalable=no or maximum-scale=1 in client shell", () => {
  assert.doesNotMatch(htmlSrc, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(htmlSrc, /maximum-scale\s*=\s*1/);
  assert.doesNotMatch(cssSrc, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(cssSrc, /maximum-scale\s*=\s*1/);
});

test("B. app shell does not force a fixed min-width wider than mobile", () => {
  assert.doesNotMatch(
    cssSrc,
    /\.app-shell\{[^}]*min-width:\s*(3[2-9]\d|[4-9]\d{2}|\d{4,})px/,
    "app-shell must not set a min-width >= 320px that exceeds narrow phones"
  );
  assert.doesNotMatch(
    cssSrc,
    /\bbody\{[^}]*min-width:\s*(3[2-9]\d|[4-9]\d{2}|\d{4,})px/,
    "body must not force a min-width that can expand past the device width"
  );
  assert.match(cssSrc, /html\{[^}]*max-width:\s*100%/);
  assert.match(cssSrc, /\bbody\{[^}]*max-width:\s*100%/);
  assert.match(cssSrc, /#root\{[^}]*max-width:\s*100%/);
  assert.match(cssSrc, /html\{[^}]*overflow-x:\s*clip/);
  assert.match(cssSrc, /\bbody\{[^}]*overflow-x:\s*clip/);
});

test("C. main flex/grid content stays shrink-safe with min-width:0", () => {
  assert.match(cssSrc, /\bmain\{[^}]*min-width:\s*0/);
  assert.match(
    cssSrc,
    /\.app-shell\{[^}]*grid-template-columns:\s*260px\s+minmax\(0,\s*1fr\)/
  );
  assert.match(cssSrc, /\.card-content\{[^}]*min-width:\s*0/);
  assert.match(
    cssSrc,
    /\.bottle-detail-hero\{[^}]*grid-template-columns:\s*180px\s+minmax\(0,\s*1fr\)/
  );
});

test("D. mobile form controls use >=16px font-size to avoid iOS focus zoom", () => {
  assert.match(
    cssSrc,
    /\/\* PR #92[\s\S]*@media\s*\(\s*max-width:\s*700px\s*\)\s*\{[\s\S]*?\binput\s*,\s*select\s*,\s*textarea\s*\{[^}]*font-size:\s*16px/
  );
});

test("E. inventory cards still wrap title/meta safely", () => {
  assert.match(
    cssSrc,
    /\.inventory-card\s+\.card-content\s+h3\{[^}]*overflow-wrap:\s*anywhere/
  );
  assert.match(cssSrc, /\.meta\{[^}]*flex-wrap:\s*wrap/);
  assert.match(
    cssSrc,
    /\.inventory-grid\{[^}]*minmax\(min\(100%,\s*300px\),\s*1fr\)/
  );
  assert.match(appSrc, /className="card-content"/);
});

test("F. bottle detail mobile breakpoint stays within viewport", () => {
  assert.match(cssSrc, /\.bottle-detail-hero\{grid-template-columns:1fr\}/);
  assert.match(
    cssSrc,
    /\.bottle-detail-hero h1\{[^}]*overflow-wrap:\s*anywhere/
  );
  assert.match(cssSrc, /\.bottle-detail-actions\{[^}]*flex-wrap:\s*wrap/);
});

test("G. bottom nav does not use width rules that exceed the viewport", () => {
  assert.match(
    cssSrc,
    /\.mobile-bottom-nav\{[^}]*width:\s*100%[^}]*max-width:\s*100%/
  );
  assert.doesNotMatch(cssSrc, /\.mobile-bottom-nav\{[^}]*width:\s*100vw/);
  assert.match(
    cssSrc,
    /\.mobile-bottom-nav\{[^}]*safe-area-inset-(?:left|right|bottom)/
  );
  assert.match(appSrc, /className="mobile-bottom-nav"/);
});

test("toasts avoid 100vw-based overflow width", () => {
  assert.doesNotMatch(cssSrc, /\.action-toast,\.notice-toast\{[^}]*100vw/);
  assert.match(
    cssSrc,
    /\.action-toast,\.notice-toast\{[^}]*max-width:\s*min\(470px,\s*calc\(100%\s*-\s*32px\)\)/
  );
});
