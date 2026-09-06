/**
 * Official beer browser smoke CLI tests — no network, no DB writes.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OfficialBeerBrowserOutcome } from "./official_brewery_beer_browser.js";
import type { OfficialBeerDiscoveryResult } from "./official_brewery_beer_discovery.js";
import {
  OFFICIAL_BEER_SMOKE_PRESETS,
  SMOKE_FORBIDDEN_WRITE_MARKERS,
  formatSmokeReport,
  parseSmokeOfficialBeerBrowserArgs,
  runOfficialBeerBrowserSmoke,
  sanitizeSmokeOutputLine,
  type SmokeHarnessDeps
} from "./smoke_official_beer_browser.js";

const smokeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "smoke_official_beer_browser.ts"),
  "utf8"
);

function emptyDiscovery(
  overrides: Partial<OfficialBeerDiscoveryResult> = {}
): OfficialBeerDiscoveryResult {
  return {
    status: "not_found",
    match: "none",
    productPageUrl: null,
    registeredDomain: "yardsbrewing.com",
    fields: {
      productName: null,
      brewery: null,
      style: null,
      abv: null,
      ibu: null,
      description: null,
      tastingNotes: null,
      packageSizes: [],
      productPageUrl: null,
      canonicalUrl: null,
      imageUrl: null
    },
    pagesFetched: 0,
    reason: "no_js_shell_evidence",
    ...overrides
  };
}

const configuredEnv: NonNullable<SmokeHarnessDeps["envDiagnostics"]> = () => ({
  figraniumBaseUrlConfigured: true,
  figraniumApiKeyConfigured: true,
  officialBeerTaskIdConfigured: true,
  figraniumConfigured: true,
  officialBrowserConfigured: true
});

test("smoke A. missing required CLI args exits helpfully", async () => {
  const parsed = parseSmokeOfficialBeerBrowserArgs(["--brewery", "Yards"]);
  const result = await runOfficialBeerBrowserSmoke(parsed, {
    envDiagnostics: () => ({
      figraniumBaseUrlConfigured: false,
      figraniumApiKeyConfigured: false,
      officialBeerTaskIdConfigured: false,
      figraniumConfigured: false,
      officialBrowserConfigured: false
    })
  });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.lines.join("\n"),
    /Missing required arguments|--brewery|--beer|--url|--presets/
  );
});

test("smoke B. browser-only mode invokes browser adapter", async () => {
  let called = false;
  const deps: SmokeHarnessDeps = {
    envDiagnostics: configuredEnv,
    renderOfficialPage: async () => {
      called = true;
      return {
        status: "ok",
        page: {
          finalUrl: "https://troegs.com/beers/perpetual-ipa",
          title: "Perpetual IPA",
          html: "<html><body><h1>Perpetual IPA</h1></body></html>",
          links: [
            {
              href: "https://troegs.com/beers/perpetual-ipa",
              text: "Perpetual IPA"
            }
          ]
        }
      } satisfies OfficialBeerBrowserOutcome;
    },
    discoverOfficialPage: async () => {
      throw new Error("discovery must not run in browser-only mode");
    }
  };

  const result = await runOfficialBeerBrowserSmoke(
    parseSmokeOfficialBeerBrowserArgs([
      "--browser-only",
      "--brewery",
      "Tröegs Independent Brewing",
      "--beer",
      "Perpetual IPA",
      "--url",
      "https://troegs.com"
    ]),
    deps
  );

  assert.equal(called, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reports[0]?.mode, "browser-only");
  assert.match(result.lines.join("\n"), /\[browser-only\]/);
  assert.match(result.lines.join("\n"), /html present: yes/);
});

test("smoke C. full mode invokes discovery only", async () => {
  let discoveryCalled = false;
  let browserCalled = false;
  const deps: SmokeHarnessDeps = {
    envDiagnostics: configuredEnv,
    skipCacheClear: true,
    renderOfficialPage: async () => {
      browserCalled = true;
      return { status: "unavailable", reason: "should_not_run" };
    },
    discoverOfficialPage: async () => {
      discoveryCalled = true;
      return emptyDiscovery({
        status: "matched",
        match: "exact_name",
        productPageUrl: "https://yardsbrewing.com/beers/brawler",
        reason: "matched",
        pagesFetched: 3,
        fields: {
          productName: "Brawler",
          brewery: "Yards Brewing Co.",
          style: "English Mild",
          abv: 4.2,
          ibu: 13,
          description: "A sessionable brown ale.",
          tastingNotes: null,
          packageSizes: ["12oz"],
          productPageUrl: "https://yardsbrewing.com/beers/brawler",
          canonicalUrl: "https://yardsbrewing.com/beers/brawler",
          imageUrl: "https://yardsbrewing.com/img/brawler.jpg"
        }
      });
    }
  };

  const result = await runOfficialBeerBrowserSmoke(
    parseSmokeOfficialBeerBrowserArgs([
      "--brewery",
      "Yards Brewing Co.",
      "--beer",
      "Brawler",
      "--url",
      "https://yardsbrewing.com"
    ]),
    deps
  );

  assert.equal(discoveryCalled, true);
  assert.equal(browserCalled, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reports[0]?.mode, "full-discovery");
  assert.match(result.lines.join("\n"), /\[full-discovery\]/);
  assert.match(result.lines.join("\n"), /route: static/);
});

test("smoke D. script source does not initialize inventory writes", () => {
  // Ignore the allowlist constant itself — it intentionally names forbidden APIs.
  const sourceWithoutAllowlist = smokeSource.replace(
    /export const SMOKE_FORBIDDEN_WRITE_MARKERS[\s\S]*?\] as const;/,
    ""
  );
  for (const marker of SMOKE_FORBIDDEN_WRITE_MARKERS) {
    assert.equal(
      sourceWithoutAllowlist.includes(marker),
      false,
      `smoke harness must not reference ${marker}`
    );
  }
  assert.match(smokeSource, /discoverOfficialBeerProductPage/);
  assert.match(smokeSource, /renderOfficialBreweryBeerPage/);
  assert.equal(sourceWithoutAllowlist.includes("better-sqlite3"), false);
  assert.equal(sourceWithoutAllowlist.includes("openDatabase"), false);
});

test("smoke E. full HTML never printed", async () => {
  const hugeHtml = `<html><body>${"SECRET_HTML_BLOB_".repeat(200)}</body></html>`;
  const result = await runOfficialBeerBrowserSmoke(
    parseSmokeOfficialBeerBrowserArgs([
      "--browser-only",
      "--brewery",
      "Yards",
      "--beer",
      "Brawler",
      "--url",
      "https://yardsbrewing.com"
    ]),
    {
      envDiagnostics: configuredEnv,
      renderOfficialPage: async () => ({
        status: "ok",
        page: {
          finalUrl: "https://yardsbrewing.com/beers/brawler",
          title: "Brawler",
          html: hugeHtml,
          links: []
        }
      })
    }
  );
  const joined = result.lines.join("\n");
  assert.equal(joined.includes("SECRET_HTML_BLOB_"), false);
  assert.match(joined, /html byte length: \d+/);
});

test("smoke F. secrets never printed", () => {
  const scrubbed = sanitizeSmokeOutputLine(
    "Authorization: Bearer super-secret-token cookie=abc x-api-key=fig-secret"
  );
  assert.equal(scrubbed.includes("super-secret-token"), false);
  assert.equal(scrubbed.includes("fig-secret"), false);
  assert.match(scrubbed, /\[redacted\]/i);
});

test("smoke G. failed discovery returns nonzero exit", async () => {
  const result = await runOfficialBeerBrowserSmoke(
    parseSmokeOfficialBeerBrowserArgs([
      "--brewery",
      "Yards Brewing Co.",
      "--beer",
      "Quantum Pickle Imperial Lager",
      "--url",
      "https://yardsbrewing.com"
    ]),
    {
      envDiagnostics: configuredEnv,
      skipCacheClear: true,
      discoverOfficialPage: async () =>
        emptyDiscovery({
          status: "not_found",
          reason: "no_js_shell_evidence",
          pagesFetched: 4
        })
    }
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join("\n"), /status: not_found/);
  assert.match(result.lines.join("\n"), /exit: 1/);
});

test("smoke H. successful discovery returns exit 0", async () => {
  const result = await runOfficialBeerBrowserSmoke(
    parseSmokeOfficialBeerBrowserArgs([
      "--brewery",
      "Victory Brewing Company",
      "--beer",
      "Golden Monkey",
      "--url",
      "https://victorybeer.com"
    ]),
    {
      envDiagnostics: configuredEnv,
      skipCacheClear: true,
      discoverOfficialPage: async () =>
        emptyDiscovery({
          status: "matched",
          match: "strong_name",
          productPageUrl: "https://victorybeer.com/beers/golden-monkey",
          registeredDomain: "victorybeer.com",
          reason: "matched",
          pagesFetched: 2,
          fields: {
            productName: "Golden Monkey",
            brewery: "Victory Brewing Company",
            style: "Belgian Tripel",
            abv: 9.5,
            ibu: 25,
            description: "A Belgian-style tripel.",
            tastingNotes: null,
            packageSizes: [],
            productPageUrl: "https://victorybeer.com/beers/golden-monkey",
            canonicalUrl: null,
            imageUrl: null
          }
        })
    }
  );
  assert.equal(result.exitCode, 0);
  const report = result.reports[0];
  assert.ok(report && report.mode === "full-discovery");
  const lines = formatSmokeReport(report);
  assert.match(lines.join("\n"), /status: matched/);
});

test("smoke I. guessed_product_url_matched reports static route, browser unused", async () => {
  const result = await runOfficialBeerBrowserSmoke(
    parseSmokeOfficialBeerBrowserArgs([
      "--brewery",
      "Victory Brewing Company",
      "--beer",
      "Sour Monkey",
      "--url",
      "https://victorybeer.com"
    ]),
    {
      envDiagnostics: configuredEnv,
      skipCacheClear: true,
      discoverOfficialPage: async () =>
        emptyDiscovery({
          status: "matched",
          match: "exact_name",
          productPageUrl: "https://victorybeer.com/beers/sour-monkey/",
          registeredDomain: "victorybeer.com",
          reason: "guessed_product_url_matched",
          pagesFetched: 1
        })
    }
  );
  assert.equal(result.exitCode, 0);
  const report = result.reports[0];
  assert.ok(report && report.mode === "full-discovery");
  if (report && report.mode === "full-discovery") {
    assert.equal(report.route, "static");
    assert.equal(report.browserUsed, false);
  }
  const lines = formatSmokeReport(report!);
  assert.match(lines.join("\n"), /route: static/);
  assert.match(lines.join("\n"), /browser used: no/);
  assert.match(lines.join("\n"), /guessed_product_url_matched/);
});

test("smoke presets list is operational fixtures only", () => {
  assert.ok(OFFICIAL_BEER_SMOKE_PRESETS.length >= 5);
  const labels = OFFICIAL_BEER_SMOKE_PRESETS.map((p) => p.label);
  assert.ok(labels.includes("troegs-perpetual-ipa"));
  assert.ok(labels.includes("dogfish-60-minute-ipa"));
  assert.ok(labels.includes("yards-brawler"));
  assert.ok(labels.includes("victory-golden-monkey"));
  assert.ok(labels.includes("yards-nonsense-negative"));
});

test("production smoke CLI: tsconfig.server.json includes compiled entrypoint", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.server.json"), "utf8")) as {
    include: string[];
    exclude?: string[];
  };
  assert.ok(tsconfig.include.some((p) => p === "src/**/*.ts" || p === "src/**/*"));
  assert.ok(
    !(tsconfig.exclude ?? []).some((p) => p.includes("smoke-official-beer-browser-cli"))
  );
  assert.ok(
    existsSync(join(root, "src/smoke-official-beer-browser-cli.ts")),
    "compiled CLI source must live under src/"
  );
});

test("production smoke CLI: package.json invokes node dist, not tsx", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const smoke = pkg.scripts["smoke:official-beer-browser"];
  assert.equal(smoke, "node dist/smoke-official-beer-browser-cli.js");
  assert.doesNotMatch(smoke, /\btsx\b/);
  assert.ok(!pkg.dependencies?.tsx, "tsx must not be a production dependency");
});

test("production smoke CLI: argv still accepts brewery/beer/url/browser-only/presets", () => {
  const parsed = parseSmokeOfficialBeerBrowserArgs([
    "--brewery",
    "Yards Brewing Co.",
    "--beer",
    "Brawler",
    "--url",
    "https://yardsbrewing.com",
    "--browser-only",
    "--presets"
  ]);
  assert.equal(parsed.brewery, "Yards Brewing Co.");
  assert.equal(parsed.beer, "Brawler");
  assert.equal(parsed.url, "https://yardsbrewing.com");
  assert.equal(parsed.browserOnly, true);
  assert.equal(parsed.presets, true);
});

test("production smoke CLI: dist entry exists after server build output", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const distCli = join(root, "dist/smoke-official-beer-browser-cli.js");
  // Build may not have run in every unit-test invocation; when dist exists, require the CLI.
  if (existsSync(join(root, "dist"))) {
    assert.ok(
      existsSync(distCli),
      "dist/smoke-official-beer-browser-cli.js must be present after build"
    );
  }
});
