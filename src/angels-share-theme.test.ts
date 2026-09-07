/**
 * Angel's Share theme + Guest availability helper contracts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  guestSpiritAvailabilityLabel,
  guestTapAvailabilityLabel,
  readAvailabilityPct,
  spiritGaugePct,
  tapGaugeForDisplay
} from "../client/src/guestAvailability.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("guestAvailability helpers prefer availability_pct and never invent pints for guests", () => {
  assert.equal(readAvailabilityPct({ availability_pct: 75 }), 75);
  assert.equal(readAvailabilityPct({ fill_level: 75 }), null);
  assert.equal(spiritGaugePct({ fill_level: 50 }, true), 50);
  assert.equal(spiritGaugePct({ availability_pct: 50, fill_level: 12 }, false), 50);
  assert.equal(spiritGaugePct({ fill_level: 50 }, false), null);
  assert.equal(guestSpiritAvailabilityLabel(0), "Last pours only");
  assert.equal(guestSpiritAvailabilityLabel(50), "Half");
  assert.equal(guestTapAvailabilityLabel(0), "Kicked");
  assert.equal(guestTapAvailabilityLabel(75), "¾");

  const guestTap = tapGaugeForDisplay({ availability_pct: 50 }, false, 19.5);
  assert.deepEqual(guestTap, { pct: 50, label: "Half" });
  assert.equal(JSON.stringify(guestTap).includes("pint"), false);

  const keeperTap = tapGaugeForDisplay({ remaining_l: 19.5, keg_size_l: 19.5 }, true, 19.5);
  assert.ok(keeperTap);
  assert.equal(keeperTap.pct, 100);
  assert.match(keeperTap.label, /pint/);
});

test("Angel's Share CSS stays scoped to data-theme=angels", () => {
  const css = readFileSync(join(root, "client/src/theme-angels.css"), "utf8");
  assert.match(css, /html\[data-theme="angels"\]/);
  // Only the settings swatch may be unscoped (visible while choosing the theme).
  const topLevelClassRules = css
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(".") && line.includes("{"));
  assert.deepEqual(topLevelClassRules, [
    ".theme-swatch.angels{background:linear-gradient(135deg,#191b19 50%,#c6a15b 50%)}"
  ]);
  // prefers-reduced-motion kill-switch uses !important (same a11y pattern as common resets).
  const importants = css.match(/!important/g) ?? [];
  assert.equal(importants.length, 4);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("Angel's Share theme wires into presets, cycle, and import", () => {
  const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
  const mainSrc = readFileSync(join(root, "client/src/main.tsx"), "utf8");
  const indexHtml = readFileSync(join(root, "client/index.html"), "utf8");
  assert.match(appSrc, /angels:\s*\{\s*"--bg"/);
  assert.match(appSrc, /if \(current === "punk"\) return "angels"/);
  assert.match(appSrc, /Angel's Share/);
  assert.match(appSrc, /\["light","dark","punk","angels"\]/);
  assert.match(appSrc, /data-page=\{page\} data-mode=\{admin \? "keeper" : "guest"\}/);
  assert.match(mainSrc, /theme-angels\.css/);
  assert.match(indexHtml, /Fraunces/);
  assert.match(indexHtml, /fonts\.googleapis\.com/);
});
