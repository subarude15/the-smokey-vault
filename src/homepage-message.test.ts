/**
 * Editable homepage message — sanitize/defaults, settings persistence, guest vs Keeper access,
 * and hero wiring (message under wordmark; no Guest edit surface).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { app, createTestAdminToken } = await import("./server.js");
const { getSetting, setSetting } = await import("./db.js");
const {
  DEFAULT_HOMEPAGE_MESSAGE,
  HOMEPAGE_MESSAGE_ENABLED_KEY,
  HOMEPAGE_MESSAGE_KEY,
  MAX_HOMEPAGE_MESSAGE,
  normalizeHomepageMessageEnabled,
  publishedHomepageMessage,
  sanitizeHomepageMessage
} = await import("./homepage-message.js");
const { overviewGreeting } = await import("./overview.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const appSrc = read("client/src/App.tsx");
const homeHeroCss = read("client/src/home-hero.css");
const depthCss = read("client/src/depth-motion.css");

test("default homepage message matches the classic guest invite", () => {
  assert.equal(DEFAULT_HOMEPAGE_MESSAGE, "Pull up a stool. Tonight's yours.");
  assert.equal(publishedHomepageMessage({}), DEFAULT_HOMEPAGE_MESSAGE);
  assert.equal(publishedHomepageMessage(undefined), DEFAULT_HOMEPAGE_MESSAGE);
});

test("sanitize strips HTML / controls and clips to 200 chars", () => {
  assert.equal(sanitizeHomepageMessage('<img src=x onerror="alert(1)">Hi'), "Hi");
  assert.equal(sanitizeHomepageMessage("Line 1\r\nLine 2"), "Line 1\nLine 2");
  assert.equal(sanitizeHomepageMessage("a".repeat(250)).length, MAX_HOMEPAGE_MESSAGE);
  assert.doesNotMatch(sanitizeHomepageMessage("<script>evil()</script>Stay"), /<|>|script/);
});

test("disable hides the published message without clearing content helpers", () => {
  assert.equal(normalizeHomepageMessageEnabled("0"), "0");
  assert.equal(normalizeHomepageMessageEnabled("1"), "1");
  assert.equal(
    publishedHomepageMessage({
      [HOMEPAGE_MESSAGE_KEY]: "Private party tonight.",
      [HOMEPAGE_MESSAGE_ENABLED_KEY]: "0"
    }),
    null
  );
  assert.equal(
    publishedHomepageMessage({
      [HOMEPAGE_MESSAGE_KEY]: "Private party tonight.",
      [HOMEPAGE_MESSAGE_ENABLED_KEY]: "1"
    }),
    "Private party tonight."
  );
});

test("time-of-day greeting stays independent of the homepage message", () => {
  const evening = overviewGreeting(new Date(2026, 7, 21, 19, 0, 0), true);
  assert.equal(evening.eyebrow, "GOOD EVENING");
  assert.equal(DEFAULT_HOMEPAGE_MESSAGE.includes(evening.eyebrow), false);
});

test("PUT /api/settings persists homepage message; disable keeps saved text", async () => {
  const token = createTestAdminToken();
  const previous = {
    message: getSetting(HOMEPAGE_MESSAGE_KEY),
    enabled: getSetting(HOMEPAGE_MESSAGE_ENABLED_KEY)
  };
  try {
    const save = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        homepage_message: "Kegs are cold.\nStay a while.",
        homepage_message_enabled: "1"
      }
    });
    assert.equal(save.statusCode, 200);
    assert.equal(getSetting(HOMEPAGE_MESSAGE_KEY), "Kegs are cold.\nStay a while.");

    const disable = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { homepage_message_enabled: "0" }
    });
    assert.equal(disable.statusCode, 200);
    assert.equal(getSetting(HOMEPAGE_MESSAGE_ENABLED_KEY), "0");
    assert.equal(getSetting(HOMEPAGE_MESSAGE_KEY), "Kegs are cold.\nStay a while.");

    const house = await app.inject({ method: "GET", url: "/api/house" });
    assert.equal(house.statusCode, 200);
    const body = house.json() as Record<string, string>;
    assert.equal(body.homepage_message, "Kegs are cold.\nStay a while.");
    assert.equal(body.homepage_message_enabled, "0");

    const xss = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { homepage_message: '<b onclick="x">Cheers</b>' }
    });
    assert.equal(xss.statusCode, 200);
    assert.equal(getSetting(HOMEPAGE_MESSAGE_KEY), "Cheers");

    const reset = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        homepage_message: DEFAULT_HOMEPAGE_MESSAGE,
        homepage_message_enabled: "1"
      }
    });
    assert.equal(reset.statusCode, 200);
    assert.equal(getSetting(HOMEPAGE_MESSAGE_KEY), DEFAULT_HOMEPAGE_MESSAGE);
    assert.equal(getSetting(HOMEPAGE_MESSAGE_ENABLED_KEY), "1");
  } finally {
    if (previous.message !== undefined) setSetting(HOMEPAGE_MESSAGE_KEY, previous.message);
    else setSetting(HOMEPAGE_MESSAGE_KEY, DEFAULT_HOMEPAGE_MESSAGE);
    if (previous.enabled !== undefined) setSetting(HOMEPAGE_MESSAGE_ENABLED_KEY, previous.enabled);
    else setSetting(HOMEPAGE_MESSAGE_ENABLED_KEY, "1");
  }
});

test("guests cannot write settings; Keeper Settings owns the editor", async () => {
  const denied = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: { "content-type": "application/json" },
    payload: { homepage_message: "Guest overwrite" }
  });
  assert.equal(denied.statusCode, 401);

  assert.match(appSrc, /Homepage message/);
  assert.match(appSrc, /homepageDraft/);
  assert.match(appSrc, /publishedHomepageMessage\(settings\)/);
  assert.match(appSrc, /className="hero-message"/);
  assert.match(appSrc, /page === "settings" && admin/);
  assert.doesNotMatch(appSrc, /page === "settings" && !admin/);
});

test("disabled homepage message hides for Guest and Keeper with no greeting fallback", () => {
  // Time-of-day eyebrow only; never restore line/emphasize when the statement is off.
  assert.match(appSrc, /\{greeting\.eyebrow\}/);
  assert.match(appSrc, /homepageMessage \? <p className="hero-message">\{homepageMessage\}<\/p> : null/);
  assert.doesNotMatch(appSrc, /homepageMessage \?[\s\S]*admin \?[\s\S]*hero-greeting/);
  assert.doesNotMatch(appSrc, /greeting\.line.*greeting\.emphasize/);
  // Redundant descriptive paragraph under the message is gone from the homepage hero.
  assert.doesNotMatch(appSrc, /className="hero-lede"/);
  assert.doesNotMatch(appSrc, /\boverviewHeroLede\b/);
});

test("hero message sits under the wordmark with contrast and clear of content overlays", () => {
  // Message is inside hero-copy after the wordmark (not orphaned under filigree); no lede after it.
  assert.match(
    appSrc,
    /className="hero-wordmark"[\s\S]*?homepageMessage[\s\S]*?className="hero-message"[\s\S]*?HopFiligree/,
  );
  assert.doesNotMatch(appSrc, /className="hero-lede"/);
  assert.match(homeHeroCss, /\.hero \.hero-message\{/);
  assert.match(homeHeroCss, /white-space:\s*pre-wrap/);
  assert.match(homeHeroCss, /--hero-pad-bottom/);
  assert.doesNotMatch(homeHeroCss, /--hero-underlap-pad/);
  assert.match(homeHeroCss, /color-mix\(in srgb,var\(--text\)/);
  // Light + Dark both use primary-text mixes (not muted-only).
  assert.match(homeHeroCss, /\[data-theme="light"\] \.hero \.hero-message/);
  assert.match(homeHeroCss, /\[data-theme="dark"\] \.hero \.hero-message/);
  // Normal flow: no sticky underlap pull-up / climbing scrim.
  assert.match(depthCss, /\.home-content\{[\s\S]*?margin-top:\s*0/);
  assert.match(depthCss, /\.home-content::before\{[\s\S]*?content:\s*none/);
  assert.doesNotMatch(depthCss, /min\(28vh,220px\)/);
  assert.doesNotMatch(depthCss, /min\(18vh,132px\)/);
  assert.doesNotMatch(homeHeroCss, /min-height:\s*clamp\(340px/);
});
