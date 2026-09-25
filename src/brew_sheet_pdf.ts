import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

export { BREW_SHEET_PDF_ERROR, brewSheetPdfFilename, pdfFilenameFromDisposition } from "./brew_sheet_pdf_shared.js";

export type BrewSheetPdfInput = { recipe: unknown; name: string };
export type BrewSheetPdfRenderer = (input: BrewSheetPdfInput) => Promise<Buffer>;

type ChromiumPage = {
  setDefaultTimeout: (ms: number) => void;
  goto: (url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }) => Promise<void>;
  waitForFunction: (fn: () => string | null, opts: { timeout: number }) => Promise<{ jsonValue: () => Promise<string | null> }>;
  evaluate: (fn: () => Promise<void>) => Promise<void>;
  pdf: (opts: object) => Promise<Uint8Array>;
  close: () => Promise<void>;
};

type ChromiumBrowser = {
  newPage: () => Promise<ChromiumPage>;
  close: () => Promise<void>;
};

const tickets = new Map<string, { recipe: unknown; expiresAt: number; reads: number }>();
const TICKET_TTL_MS = 60_000;
const TICKET_MAX_READS = 4;

/** One recipe, a few reads, about a minute. The token never leaves the server. */
export function issueBrewSheetTicket(recipe: unknown): string {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(token);
  }
  const token = randomBytes(24).toString("base64url");
  tickets.set(token, { recipe, expiresAt: now + TICKET_TTL_MS, reads: 0 });
  return token;
}

export function claimBrewSheetTicket(token: string): unknown | null {
  const ticket = tickets.get(token);
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.reads >= TICKET_MAX_READS) {
    if (ticket) tickets.delete(token);
    return null;
  }
  ticket.reads += 1;
  return ticket.recipe;
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
];

export function resolveChromiumPath(): string {
  const configured = process.env.CHROMIUM_PATH?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error("Configured Chromium executable is missing");
    return configured;
  }
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chromium executable is missing");
}

function brewPdfTimeoutMs(): number {
  const parsed = Number(process.env.BREW_PDF_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000) return parsed;
  return 20_000;
}

function printOrigin(): string {
  const configured = process.env.BREW_SHEET_PRINT_ORIGIN?.trim().replace(/\/$/, "") ?? "";
  const origin = configured || `http://127.0.0.1:${process.env.PORT ?? "8080"}`;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    throw new Error("Brew sheet print origin must stay on localhost");
  }
  return origin;
}

export function redactBrewSheetSecrets(value: string): string {
  return value
    .replace(/token=[^&\s'"]+/gi, "token=redacted")
    .replace(/(\/api\/brew-sheet-render\/)[^/?\s'"]+/g, "$1redacted")
    .replace(/Bearer\s+\S+/gi, "Bearer redacted");
}

let renderer: BrewSheetPdfRenderer = renderBrewSheetPdfWithChromium;

/** Tests pass a fake renderer. Null restores headless Chromium. */
export function setBrewSheetPdfRenderer(next: BrewSheetPdfRenderer | null) {
  renderer = next ?? renderBrewSheetPdfWithChromium;
}

export function renderBrewSheetPdf(input: BrewSheetPdfInput) {
  return renderer(input);
}

// --no-sandbox: the runtime image runs as root, and Chromium refuses its sandbox there.
// --disable-dev-shm-usage: Docker's /dev/shm is small and Chromium crashes when it fills.
const CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];

export async function renderBrewSheetPdfWithChromium(input: BrewSheetPdfInput): Promise<Buffer> {
  const specifier = "playwright-core";
  const { chromium } = await import(specifier) as {
    chromium: { launch: (options: { executablePath: string; headless: boolean; timeout: number; args: string[] }) => Promise<ChromiumBrowser> };
  };
  const token = issueBrewSheetTicket(input.recipe);
  const timeout = brewPdfTimeoutMs();
  const url = `${printOrigin()}/brew-sheet-print.html?token=${encodeURIComponent(token)}`;
  let browser: ChromiumBrowser | undefined;
  let page: ChromiumPage | undefined;
  try {
    browser = await chromium.launch({
      executablePath: resolveChromiumPath(),
      headless: true,
      timeout,
      args: CHROMIUM_ARGS
    });
    page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    const state = await (await page.waitForFunction(() => {
      const marker = document.querySelector("[data-brew-sheet-ready]")?.getAttribute("data-brew-sheet-ready");
      if (marker === "error" || marker === "true") return marker;
      return null;
    }, { timeout })).jsonValue();
    if (state !== "true") throw new Error("Brew sheet print page failed");
    await page.evaluate(async () => { await document.fonts.ready; });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      timeout
    });
    return Buffer.from(pdf);
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
