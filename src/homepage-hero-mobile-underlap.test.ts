/**
 * Homepage hero underlap clearance — computed-style regression.
 *
 * Source-string checks alone missed the PR160 bug: `.home-content::before` was a
 * foreground gradient climbing 112–176px into the hero while `.home-content`
 * (z-index:2) stacked above the sticky pin (z-index:0), darkening the
 * configurable message at every length. Sticky + hero negative-margin collapse
 * also mis-placed the desktop runway so the “shallow bite” became a deep overlap.
 *
 * This test loads the real CSS in Chromium and asserts normal-flow geometry:
 * no sticky pin, no runway, no upward scrim, message fully clear of the CTA plane
 * for short and max-length copy across phone viewports (and a desktop control).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chromeCandidates = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/google-chrome",
].filter((p): p is string => Boolean(p));

function resolveChrome(): string {
  for (const path of chromeCandidates) {
    if (existsSync(path)) return path;
  }
  throw new Error("No Chromium binary found for homepage underlap regression");
}

const depthCss = readFileSync(join(root, "client/src/depth-motion.css"), "utf8");
const homeHeroCss = readFileSync(join(root, "client/src/home-hero.css"), "utf8");
const stylesCss = readFileSync(join(root, "client/src/styles.css"), "utf8");

const fixtureCss = `
${stylesCss}
${homeHeroCss}
${depthCss}
.topbar{position:sticky;top:0;height:72px;z-index:5;background:var(--surface)}
.page{padding:0 16px 96px}
`;

function fixtureHtml(message: string | null, theme: "dark" | "light" = "dark"): string {
  const messageHtml = message == null ? "" : `<p class="hero-message">${escapeHtml(message)}</p>`;
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>${fixtureCss}</style>
</head>
<body>
<header class="topbar">Vault</header>
<main class="page">
  <div class="home-stack">
    <div class="home-opening">
      <div class="home-hero-pin">
        <div class="hero">
          <div class="hero-copy">
            <span class="eyebrow">Good evening</span>
            <span class="hero-wordmark" role="heading" aria-level="1">The Smokey Barrel</span>
            ${messageHtml}
          </div>
        </div>
      </div>
      <div class="home-hero-runway" aria-hidden="true"></div>
    </div>
    <div class="home-content">
      <div class="tonight-cta">
        <button type="button" class="primary">Find a drink</button>
        <button type="button" class="secondary">Browse the shelf</button>
      </div>
      <section><h2>Inside The Smokey Barrel</h2></section>
    </div>
  </div>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type Geometry = {
  pinPosition: string;
  runwayHeight: number;
  contentMarginTop: number;
  contentZIndex: string;
  scrimContent: string;
  scrimHeight: number;
  messageBottom: number | null;
  contentTop: number;
  messageOverlappedByContent: boolean;
  messageOverlappedByScrim: boolean;
};

async function measure(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const pin = document.querySelector(".home-hero-pin") as HTMLElement;
    const runway = document.querySelector(".home-hero-runway") as HTMLElement;
    const content = document.querySelector(".home-content") as HTMLElement;
    const message = document.querySelector(".hero-message") as HTMLElement | null;
    const pinStyle = getComputedStyle(pin);
    const contentStyle = getComputedStyle(content);
    const before = getComputedStyle(content, "::before");
    const contentBox = content.getBoundingClientRect();
    const messageBox = message?.getBoundingClientRect() ?? null;
    const scrimHeight = Number.parseFloat(before.height) || 0;
    const scrimTop = contentBox.top - scrimHeight;
    const scrimBottom = contentBox.top;
    const messageOverlappedByContent = Boolean(
      messageBox && messageBox.bottom > contentBox.top + 0.5,
    );
    const messageOverlappedByScrim = Boolean(
      messageBox &&
        scrimHeight > 0 &&
        before.content !== "none" &&
        messageBox.bottom > scrimTop + 0.5 &&
        messageBox.top < scrimBottom - 0.5,
    );
    return {
      pinPosition: pinStyle.position,
      runwayHeight: runway.getBoundingClientRect().height,
      contentMarginTop: Number.parseFloat(contentStyle.marginTop) || 0,
      contentZIndex: contentStyle.zIndex,
      scrimContent: before.content,
      scrimHeight,
      messageBottom: messageBox ? messageBox.bottom : null,
      contentTop: contentBox.top,
      messageOverlappedByContent,
      messageOverlappedByScrim,
    };
  });
}

function assertClearance(geo: Geometry, label: string) {
  assert.equal(geo.pinPosition, "relative", `${label}: sticky pin must be disabled`);
  assert.equal(geo.runwayHeight, 0, `${label}: runway must collapse`);
  assert.equal(geo.contentMarginTop, 0, `${label}: content must not pull up over the hero`);
  assert.ok(
    geo.scrimContent === "none" || geo.scrimHeight === 0,
    `${label}: foreground scrim must be disabled (content=${geo.scrimContent}, height=${geo.scrimHeight})`,
  );
  assert.equal(geo.messageOverlappedByContent, false, `${label}: content must not cover message`);
  assert.equal(geo.messageOverlappedByScrim, false, `${label}: scrim must not cover message`);
  if (geo.messageBottom != null) {
    assert.ok(
      geo.contentTop >= geo.messageBottom - 0.5,
      `${label}: message bottom (${geo.messageBottom}) must clear content top (${geo.contentTop})`,
    );
  }
}

const viewports = [
  { name: "iphone-se", width: 375, height: 667 },
  { name: "iphone-14", width: 390, height: 844 },
  { name: "android-chrome", width: 360, height: 800 },
  { name: "android-landscape", width: 800, height: 360 },
] as const;

const messages = [
  { name: "disabled", text: null as string | null },
  { name: "one-line", text: "Welcome to the vault." },
  { name: "two-line", text: "Tonight the cellar is open.\nPull up a stool." },
  {
    name: "four-line",
    text: "Line one of the house note.\nLine two keeps going.\nLine three still clear.\nLine four stays readable.",
  },
  {
    name: "max-200",
    text: "A".repeat(200),
  },
] as const;

let browser: Browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

after(async () => {
  await browser?.close();
});

const shotDir = process.env.HOMEPAGE_HERO_UNDERLAP_SHOTS?.trim() || "";

test("mobile homepage hero uses normal flow with no underlap overlay on the message", async (t) => {
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  for (const viewport of viewports) {
    for (const theme of ["dark", "light"] as const) {
      for (const message of messages) {
        await t.test(`${viewport.name}/${theme}/${message.name}`, async () => {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          try {
            await page.setContent(fixtureHtml(message.text, theme), {
              waitUntil: "load",
            });
            const geo = await measure(page);
            assertClearance(geo, `${viewport.name}/${theme}/${message.name}`);

            if (
              shotDir &&
              viewport.height >= viewport.width &&
              message.name === "max-200"
            ) {
              const shot = join(shotDir, `${viewport.name}-${theme}-max-200.png`);
              await page.screenshot({ path: shot, fullPage: false });
              writeFileSync(
                join(shotDir, `${viewport.name}-${theme}-max-200.json`),
                JSON.stringify(geo, null, 2),
              );
            }
          } finally {
            await page.close();
          }
        });
      }
    }
  }
});

test("desktop homepage hero also keeps the message clear of underlap overlays", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(fixtureHtml("A".repeat(200), "dark"), { waitUntil: "load" });
    const geo = await measure(page);
    assertClearance(geo, "desktop/max-200");

    if (shotDir) {
      mkdirSync(shotDir, { recursive: true });
      await page.screenshot({
        path: join(shotDir, "desktop-dark-max-200.png"),
        fullPage: false,
      });
    }
  } finally {
    await page.close();
  }
});
