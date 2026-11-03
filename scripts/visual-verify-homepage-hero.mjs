/**
 * Real-app visual verification for homepage hero underlap fix (PR #184).
 * Requires a running server (default http://127.0.0.1:8080).
 *
 * Usage:
 *   HOMEPAGE_HERO_SHOTS=/path/to/media node scripts/visual-verify-homepage-hero.mjs
 *
 * Keeps fixture/computed-style unit tests separate — this hits the actual guest UI.
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const baseUrl = (process.env.SMOKEY_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const pin = process.env.DEFAULT_PIN || "1234";
const shotDir =
  process.env.HOMEPAGE_HERO_SHOTS?.trim() ||
  "/cursor/stores/bc-01a112a7-acde-7519-ac15-34e63f4ebe00/media";
const chromeCandidates = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/google-chrome",
].filter(Boolean);

function resolveChrome() {
  for (const path of chromeCandidates) {
    if (existsSync(path)) return path;
  }
  throw new Error("No Chromium binary found");
}

const SHORT_MESSAGE = "Pull up a stool. Tonight's yours.";
const MAX_MESSAGE = "A".repeat(200);

/** Filenames match the review brief: real-app-<device>-<theme>-<msg>.png */
const viewports = [
  { name: "iphone14", width: 390, height: 844 },
  { name: "iphonese", width: 375, height: 667 },
  { name: "android", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
];

async function unlockToken() {
  const res = await fetch(`${baseUrl}/api/auth/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) throw new Error(`unlock failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

async function putHomepageMessage(token, message) {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      homepage_message: message,
      homepage_message_enabled: "1",
    }),
  });
  if (!res.ok) throw new Error(`settings put failed: ${res.status} ${await res.text()}`);
}

async function openGuestHome(page, theme) {
  await page.addInitScript((t) => {
    localStorage.setItem("smokey-theme", t);
    localStorage.setItem("smokey-nav-hint-dismissed", "1");
  }, theme);
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".hero-wordmark svg path", { timeout: 15000 });
  await page.waitForSelector(".hero-message", { timeout: 15000 });
  await page.waitForSelector(".hero-filigree", { timeout: 15000 });
  // Closed More sheet still extends fullPage height via transform; hide for clean shots.
  await page.addStyleTag({
    content: `
      .more-sheet, .more-sheet-overlay { display: none !important; }
      .nav-hint { display: none !important; }
    `,
  });
  await page.waitForTimeout(200);
}

async function measureAndAssert(page, label, expectedMessage) {
  const result = await page.evaluate((expected) => {
    const wordmark = document.querySelector(".hero-wordmark svg");
    const filigree = document.querySelector(".hero-filigree");
    const message = document.querySelector(".hero-message");
    const cta = document.querySelector(".tonight-cta");
    const nav =
      document.querySelector(".mobile-bottom-nav") ||
      document.querySelector(".sidebar nav, .sidebar") ||
      document.querySelector("nav");
    const hero = document.querySelector(".hero");
    const content = document.querySelector(".home-content");
    const pinEl = document.querySelector(".home-hero-pin");
    const runway = document.querySelector(".home-hero-runway");
    const heroBox = hero?.getBoundingClientRect();
    const messageBox = message?.getBoundingClientRect();
    const contentBox = content?.getBoundingClientRect();
    const before = content ? getComputedStyle(content, "::before") : null;
    const scrimHeight = before ? Number.parseFloat(before.height) || 0 : 0;
    const emptyBelowMessage =
      messageBox && heroBox ? heroBox.bottom - messageBox.bottom : null;
    const padBottom = hero ? Number.parseFloat(getComputedStyle(hero).paddingBottom) || 0 : 0;

    return {
      hasWordmarkSvg: Boolean(wordmark && wordmark.querySelector("path")),
      wordmarkPathCount: wordmark ? wordmark.querySelectorAll("path").length : 0,
      hasFiligree: Boolean(filigree && (filigree.querySelector("path") || filigree.tagName === "svg")),
      messageText: message?.textContent ?? null,
      messageMatchesExpected: (message?.textContent ?? "") === expected,
      hasCta: Boolean(cta && cta.querySelector("button")),
      ctaCount: cta ? cta.querySelectorAll("button").length : 0,
      hasNav: Boolean(nav),
      pinPosition: pinEl ? getComputedStyle(pinEl).position : null,
      runwayHeight: runway?.getBoundingClientRect().height ?? null,
      contentMarginTop: content ? Number.parseFloat(getComputedStyle(content).marginTop) || 0 : null,
      scrimContent: before?.content ?? null,
      scrimHeight,
      messageClearOfContent: Boolean(
        messageBox && contentBox && messageBox.bottom <= contentBox.top + 0.5,
      ),
      emptyBelowMessage,
      padBottom,
      heroHeight: heroBox?.height ?? null,
      theme: document.documentElement.getAttribute("data-theme"),
    };
  }, expectedMessage);

  const failures = [];
  if (!result.hasWordmarkSvg) failures.push("missing SVG wordmark paths");
  if (result.wordmarkPathCount < 2) failures.push(`wordmark path count ${result.wordmarkPathCount}`);
  if (!result.hasFiligree) failures.push("missing hop filigree");
  if (!result.messageMatchesExpected) failures.push("homepage message mismatch");
  if (!result.hasCta || result.ctaCount < 1) failures.push("missing tonight CTAs");
  if (!result.hasNav) failures.push("missing navigation");
  if (result.pinPosition !== "relative") failures.push(`pin position ${result.pinPosition}`);
  if (result.runwayHeight !== 0) failures.push(`runway height ${result.runwayHeight}`);
  if (result.contentMarginTop !== 0) failures.push(`content margin-top ${result.contentMarginTop}`);
  if (!(result.scrimContent === "none" || result.scrimHeight === 0)) {
    failures.push(`scrim still active content=${result.scrimContent} h=${result.scrimHeight}`);
  }
  if (!result.messageClearOfContent) failures.push("message overlapped by content plane");
  if (result.emptyBelowMessage != null && result.emptyBelowMessage > 120) {
    failures.push(`excessive empty hero below message: ${result.emptyBelowMessage.toFixed(1)}px`);
  }
  if (result.padBottom > 80) {
    failures.push(`hero padding-bottom still large underlap-style: ${result.padBottom}px`);
  }

  return { label, ok: failures.length === 0, failures, result };
}

async function main() {
  mkdirSync(shotDir, { recursive: true });
  const token = await unlockToken();
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const report = [];
  const messages = [
    { key: "short", text: SHORT_MESSAGE },
    { key: "max200", text: MAX_MESSAGE },
  ];

  try {
    for (const message of messages) {
      await putHomepageMessage(token, message.text);

      for (const theme of ["dark", "light"]) {
        for (const viewport of viewports) {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          try {
            await openGuestHome(page, theme);
            const label = `real-app-${viewport.name}-${theme}-${message.key}`;
            const check = await measureAndAssert(page, label, message.text);
            if (theme !== check.result.theme) {
              check.failures.push(`theme ${check.result.theme} != ${theme}`);
              check.ok = false;
            }

            const viewportPath = join(shotDir, `${label}.png`);
            await page.screenshot({ path: viewportPath, fullPage: false });

            // Hero + CTA strip for dense review (clip from top through tonight-cta).
            const heroClip = await page.evaluate(() => {
              const hero = document.querySelector(".hero");
              const cta = document.querySelector(".tonight-cta") || document.querySelector(".home-content");
              if (!hero || !cta) return null;
              const top = Math.max(0, hero.getBoundingClientRect().top);
              const bottom = cta.getBoundingClientRect().bottom + 12;
              return {
                x: 0,
                y: top,
                width: Math.min(window.innerWidth, document.documentElement.clientWidth),
                height: Math.min(window.innerHeight - top, Math.max(80, bottom - top)),
              };
            });
            if (heroClip && heroClip.height > 40) {
              await page.screenshot({
                path: join(shotDir, `${label}-hero.png`),
                clip: heroClip,
              });
            }

            check.shotPath = viewportPath;
            report.push(check);
            console.log(check.ok ? "OK  " : "FAIL", label, check.ok ? "" : check.failures.join("; "));
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const summaryPath = join(shotDir, "real-app-homepage-hero-verify.json");
  writeFileSync(summaryPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${report.length} viewport shots (+ hero crops) to ${shotDir}`);
  console.log(`Summary: ${summaryPath}`);
  if (report.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
