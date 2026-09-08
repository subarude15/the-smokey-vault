/**
 * Light/Dark appearance selection and obsolete-theme fallback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  THEME_NAMES,
  cycleTheme,
  resolveTheme,
  storedTheme,
  themeLabel,
  themePresets
} from "../client/src/theme.ts";

test("supported themes are light and dark only", () => {
  assert.deepEqual([...THEME_NAMES], ["light", "dark"]);
  assert.deepEqual(Object.keys(themePresets).sort(), ["dark", "light"]);
  assert.ok(themePresets.light["--bg"]);
  assert.ok(themePresets.dark["--bg"]);
});

test("resolveTheme keeps light and dark; obsolete and unknown fall back to dark", () => {
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("dark"), "dark");
  assert.equal(resolveTheme("punk"), "dark");
  assert.equal(resolveTheme("angels"), "dark");
  assert.equal(resolveTheme("neon"), "dark");
  assert.equal(resolveTheme(""), "dark");
  assert.equal(resolveTheme(null), "dark");
  assert.equal(resolveTheme(undefined), "dark");
});

test("storedTheme reads local preference and migrates obsolete values to dark", () => {
  assert.equal(storedTheme(() => "light"), "light");
  assert.equal(storedTheme(() => "dark"), "dark");
  assert.equal(storedTheme(() => "punk"), "dark");
  assert.equal(storedTheme(() => "angels"), "dark");
  assert.equal(storedTheme(() => "whatever"), "dark");
  assert.equal(storedTheme(() => null), "dark");
});

test("cycleTheme toggles only between light and dark", () => {
  assert.equal(cycleTheme("light"), "dark");
  assert.equal(cycleTheme("dark"), "light");
  // Obsolete persisted values behave as Dark, then toggle to Light.
  assert.equal(cycleTheme("punk"), "light");
  assert.equal(cycleTheme("angels"), "light");
  assert.equal(cycleTheme("unknown"), "light");

  let theme = cycleTheme("light");
  for (let i = 0; i < 8; i += 1) {
    assert.ok(theme === "light" || theme === "dark");
    theme = cycleTheme(theme);
  }
});

test("themeLabel only surfaces Light or Dark", () => {
  assert.equal(themeLabel("light"), "Light");
  assert.equal(themeLabel("dark"), "Dark");
  assert.equal(themeLabel("punk"), "Dark");
  assert.equal(themeLabel("angels"), "Dark");
});
