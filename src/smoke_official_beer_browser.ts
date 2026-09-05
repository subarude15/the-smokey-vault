/**
 * Read-only official-brewery browser / discovery smoke harness.
 *
 * Calls discovery + browser adapter only. Never writes inventory, beer_cache,
 * enrichment tables, or enqueues jobs. Safe for ops validation of PR104.
 */
import {
  getFigraniumApiKey,
  getFigraniumBaseUrl,
  isFigraniumConfigured
} from "./figranium.js";
import { registeredDomain } from "./ingestion/enrichment/official-domain.js";
import {
  getOfficialBeerBrowserTaskId,
  isOfficialBeerBrowserConfigured,
  renderOfficialBreweryBeerPage,
  type OfficialBeerBrowserDeps,
  type OfficialBeerBrowserOutcome
} from "./official_brewery_beer_browser.js";
import {
  clearOfficialBeerDiscoveryCache,
  discoverOfficialBeerProductPage,
  type OfficialBeerDiscoveryDeps,
  type OfficialBeerDiscoveryResult
} from "./official_brewery_beer_discovery.js";

export type SmokeTarget = {
  brewery: string;
  beer: string;
  url: string;
  /** Operational fixture label (presets only). */
  label?: string;
  /** Expected outcome for documentation / exit heuristics. */
  expect?: "matched" | "not_matched" | "static_preferred";
};

export type SmokeCliArgs = {
  brewery: string | null;
  beer: string | null;
  url: string | null;
  browserOnly: boolean;
  presets: boolean;
  help: boolean;
  unknown: string[];
};

export type SmokeEnvDiagnostics = {
  figraniumBaseUrlConfigured: boolean;
  figraniumApiKeyConfigured: boolean;
  officialBeerTaskIdConfigured: boolean;
  figraniumConfigured: boolean;
  officialBrowserConfigured: boolean;
};

export type BrowserOnlySmokeReport = {
  mode: "browser-only";
  target: SmokeTarget;
  taskConfigured: boolean;
  status: OfficialBeerBrowserOutcome["status"];
  reason?: string;
  finalHost: string | null;
  title: string | null;
  htmlPresent: boolean;
  htmlByteLength: number;
  sameDomainLinkCount: number;
};

export type FullDiscoverySmokeReport = {
  mode: "full-discovery";
  target: SmokeTarget;
  route: "static" | "browser" | "unknown";
  browserUsed: boolean;
  status: OfficialBeerDiscoveryResult["status"];
  match: OfficialBeerDiscoveryResult["match"];
  productPageUrl: string | null;
  registeredDomain: string | null;
  reason: string | null;
  pagesFetched: number;
  fields: {
    abv: number | null;
    ibu: number | null;
    style: string | null;
    hasDescription: boolean;
    hasImageCandidate: boolean;
  };
};

export type SmokeReport = BrowserOnlySmokeReport | FullDiscoverySmokeReport;

export type SmokeRunResult = {
  exitCode: number;
  reports: SmokeReport[];
  lines: string[];
};

export type SmokeHarnessDeps = {
  renderOfficialPage?: typeof renderOfficialBreweryBeerPage;
  discoverOfficialPage?: typeof discoverOfficialBeerProductPage;
  clearCache?: typeof clearOfficialBeerDiscoveryCache;
  envDiagnostics?: () => SmokeEnvDiagnostics;
  browserDeps?: OfficialBeerBrowserDeps;
  discoveryDeps?: OfficialBeerDiscoveryDeps;
  /** When true, skip clearing the in-memory discovery cache (tests). */
  skipCacheClear?: boolean;
};

/**
 * Markers that must never appear as imports/calls in this harness module.
 * Used by unit tests to prove the smoke path stays read-only.
 */
export const SMOKE_FORBIDDEN_WRITE_MARKERS = [
  "runMetadataJob",
  "applyOfficialBreweryBeerDiscovery",
  "persistMetadataImprovements",
  "upsertEnrichmentSource",
  "upsertProductContent",
  "enqueueEnrichment",
  "better-sqlite3",
  "openDatabase",
  "getDb"
] as const;

/** Operational fixtures only — not canonical product records. */
export const OFFICIAL_BEER_SMOKE_PRESETS: SmokeTarget[] = [
  {
    label: "troegs-perpetual-ipa",
    brewery: "Tröegs Independent Brewing",
    beer: "Perpetual IPA",
    url: "https://troegs.com",
    expect: "matched"
  },
  {
    label: "dogfish-60-minute-ipa",
    brewery: "Dogfish Head",
    beer: "60 Minute IPA",
    url: "https://dogfish.com",
    expect: "matched"
  },
  {
    label: "yards-brawler",
    brewery: "Yards Brewing Co.",
    beer: "Brawler",
    url: "https://yardsbrewing.com",
    expect: "static_preferred"
  },
  {
    label: "victory-golden-monkey",
    brewery: "Victory Brewing Company",
    beer: "Golden Monkey",
    url: "https://victorybeer.com",
    expect: "static_preferred"
  },
  {
    label: "yards-nonsense-negative",
    brewery: "Yards Brewing Co.",
    beer: "Quantum Pickle Imperial Lager",
    url: "https://yardsbrewing.com",
    expect: "not_matched"
  }
];

export function parseSmokeOfficialBeerBrowserArgs(argv: string[]): SmokeCliArgs {
  const args: SmokeCliArgs = {
    brewery: null,
    beer: null,
    url: null,
    browserOnly: false,
    presets: false,
    help: false,
    unknown: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--browser-only") {
      args.browserOnly = true;
      continue;
    }
    if (token === "--presets") {
      args.presets = true;
      continue;
    }
    if (token === "--brewery" || token === "--beer" || token === "--url") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        args.unknown.push(`${token} (missing value)`);
        continue;
      }
      i += 1;
      if (token === "--brewery") args.brewery = value;
      else if (token === "--beer") args.beer = value;
      else args.url = value;
      continue;
    }
    args.unknown.push(token);
  }

  return args;
}

export function formatSmokeUsage(): string {
  return [
    "Usage:",
    "  npm run smoke:official-beer-browser -- --brewery <name> --beer <name> --url <https://...>",
    "  npm run smoke:official-beer-browser -- --browser-only --brewery <name> --beer <name> --url <https://...>",
    "  npm run smoke:official-beer-browser -- --presets",
    "",
    "Read-only: discovery/browser adapter only. No inventory or enrichment writes."
  ].join("\n");
}

export function collectSmokeEnvDiagnostics(
  env: NodeJS.ProcessEnv = process.env
): SmokeEnvDiagnostics {
  return {
    figraniumBaseUrlConfigured: Boolean(String(env.FIGRANIUM_BASE_URL ?? "").trim()),
    figraniumApiKeyConfigured: Boolean(String(env.FIGRANIUM_API_KEY ?? "").trim()),
    officialBeerTaskIdConfigured: Boolean(getOfficialBeerBrowserTaskId(env)),
    figraniumConfigured: isFigraniumConfigured(),
    officialBrowserConfigured: isOfficialBeerBrowserConfigured(env)
  };
}

export function formatSmokeEnvDiagnostics(diag: SmokeEnvDiagnostics): string[] {
  return [
    `FIGRANIUM_BASE_URL configured: ${diag.figraniumBaseUrlConfigured ? "yes" : "no"}`,
    `FIGRANIUM_API_KEY configured: ${diag.figraniumApiKeyConfigured ? "yes" : "no"}`,
    `FIGRANIUM_OFFICIAL_BEER_TASK_ID configured: ${diag.officialBeerTaskIdConfigured ? "yes" : "no"}`
  ];
}

function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function resolveRegisteredDomainFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return registeredDomain(host) || host.toLowerCase();
  } catch {
    return "";
  }
}

function inferDiscoveryRoute(result: OfficialBeerDiscoveryResult): {
  route: FullDiscoverySmokeReport["route"];
  browserUsed: boolean;
} {
  const reason = String(result.reason || "");
  if (
    reason === "browser_matched" ||
    reason === "browser_no_strong_match" ||
    reason === "browser_transient_failure"
  ) {
    return { route: "browser", browserUsed: true };
  }
  if (reason === "browser_unconfigured" || reason === "no_js_shell_evidence") {
    // Browser path considered but not used for rendering.
    return { route: "static", browserUsed: false };
  }
  if (reason === "matched") {
    return { route: "static", browserUsed: false };
  }
  if (
    result.status === "unsupported_static_site" ||
    result.status === "not_found" ||
    result.status === "matched"
  ) {
    return { route: "static", browserUsed: false };
  }
  return { route: "unknown", browserUsed: false };
}

export function formatBrowserOnlyReport(report: BrowserOnlySmokeReport): string[] {
  return [
    `[browser-only] ${report.target.brewery} / ${report.target.beer}`,
    `  official domain seed: ${report.target.url}`,
    `  task configured: ${report.taskConfigured ? "yes" : "no"}`,
    `  status: ${report.status}`,
    report.reason ? `  reason: ${report.reason}` : null,
    `  final host: ${report.finalHost ?? "(none)"}`,
    `  title: ${report.title ?? "(none)"}`,
    `  html present: ${report.htmlPresent ? "yes" : "no"}`,
    `  html byte length: ${report.htmlByteLength}`,
    `  same-domain links: ${report.sameDomainLinkCount}`
  ].filter((line): line is string => line != null);
}

export function formatFullDiscoveryReport(report: FullDiscoverySmokeReport): string[] {
  return [
    `[full-discovery] ${report.target.brewery} / ${report.target.beer}`,
    `  official domain seed: ${report.target.url}`,
    `  route: ${report.route}`,
    `  browser used: ${report.browserUsed ? "yes" : "no"}`,
    `  status: ${report.status}`,
    `  match: ${report.match}`,
    `  registered domain: ${report.registeredDomain ?? "(none)"}`,
    `  product page URL: ${report.productPageUrl ?? "(none)"}`,
    report.reason ? `  reason: ${report.reason}` : null,
    `  pages fetched: ${report.pagesFetched}`,
    `  ABV: ${report.fields.abv ?? "(none)"}`,
    `  IBU: ${report.fields.ibu ?? "(none)"}`,
    `  style: ${report.fields.style ?? "(none)"}`,
    `  has description: ${report.fields.hasDescription ? "yes" : "no"}`,
    `  has image candidate: ${report.fields.hasImageCandidate ? "yes" : "no"}`
  ].filter((line): line is string => line != null);
}

export function formatSmokeReport(report: SmokeReport): string[] {
  return report.mode === "browser-only"
    ? formatBrowserOnlyReport(report)
    : formatFullDiscoveryReport(report);
}

/**
 * Scrub accidental secret/HTML leakage from operator-facing lines.
 * Never print API keys, Authorization headers, cookies, or full HTML blobs.
 */
export function sanitizeSmokeOutputLine(line: string): string {
  let out = line;
  const apiKey = getFigraniumApiKey();
  if (apiKey) {
    out = out.split(apiKey).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/x-api-key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "x-api-key=[redacted]");
  out = out.replace(/cookie["']?\s*[:=]\s*["']?[^"'\s]+/gi, "cookie=[redacted]");
  if (out.length > 2_000 && /<\/?[a-z][\s\S]*>/i.test(out)) {
    out = `[omitted oversized HTML-like output (${out.length} chars)]`;
  }
  void getFigraniumBaseUrl;
  return out;
}

function exitCodeForReports(reports: SmokeReport[], targets: SmokeTarget[]): number {
  if (reports.length === 0) return 1;
  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i]!;
    const expect = targets[i]?.expect;
    if (report.mode === "browser-only") {
      if (report.status === "ok") continue;
      if (report.status === "unavailable" && !report.taskConfigured) continue;
      return 1;
    }
    if (expect === "not_matched") {
      if (report.status === "matched") return 1;
      continue;
    }
    if (expect === "matched") {
      if (report.status !== "matched") return 1;
      continue;
    }
    if (expect === "static_preferred") {
      if (report.status === "error" || report.status === "invalid_input") return 1;
      continue;
    }
    if (report.status !== "matched") return 1;
  }
  return 0;
}

export async function runBrowserOnlySmoke(
  target: SmokeTarget,
  deps: SmokeHarnessDeps = {}
): Promise<BrowserOnlySmokeReport> {
  const diag = (deps.envDiagnostics ?? collectSmokeEnvDiagnostics)();
  const domain = resolveRegisteredDomainFromUrl(target.url);
  const render = deps.renderOfficialPage ?? renderOfficialBreweryBeerPage;
  const outcome = await render(
    {
      url: target.url,
      breweryName: target.brewery,
      beerName: target.beer,
      registeredDomain: domain || "invalid.example"
    },
    deps.browserDeps
  );

  if (outcome.status === "ok") {
    const html = outcome.page.html;
    return {
      mode: "browser-only",
      target,
      taskConfigured: diag.officialBrowserConfigured,
      status: "ok",
      finalHost: hostFromUrl(outcome.page.finalUrl),
      title: outcome.page.title,
      htmlPresent: Boolean(html?.trim()),
      htmlByteLength: html ? Buffer.byteLength(html, "utf8") : 0,
      sameDomainLinkCount: outcome.page.links.length
    };
  }

  return {
    mode: "browser-only",
    target,
    taskConfigured: diag.officialBrowserConfigured,
    status: outcome.status,
    reason: outcome.reason,
    finalHost: null,
    title: null,
    htmlPresent: false,
    htmlByteLength: 0,
    sameDomainLinkCount: 0
  };
}

export async function runFullDiscoverySmoke(
  target: SmokeTarget,
  deps: SmokeHarnessDeps = {}
): Promise<FullDiscoverySmokeReport> {
  if (!deps.skipCacheClear) {
    (deps.clearCache ?? clearOfficialBeerDiscoveryCache)();
  }
  const discover = deps.discoverOfficialPage ?? discoverOfficialBeerProductPage;
  const result = await discover(
    {
      breweryName: target.brewery,
      beerName: target.beer,
      breweryWebsiteUrl: target.url
    },
    deps.discoveryDeps
  );
  const { route, browserUsed } = inferDiscoveryRoute(result);
  return {
    mode: "full-discovery",
    target,
    route,
    browserUsed,
    status: result.status,
    match: result.match,
    productPageUrl: result.productPageUrl,
    registeredDomain: result.registeredDomain,
    reason: result.reason ?? null,
    pagesFetched: result.pagesFetched,
    fields: {
      abv: result.fields.abv,
      ibu: result.fields.ibu,
      style: result.fields.style,
      hasDescription: Boolean(result.fields.description?.trim()),
      hasImageCandidate: Boolean(result.fields.imageUrl?.trim())
    }
  };
}

export async function runOfficialBeerBrowserSmoke(
  args: SmokeCliArgs,
  deps: SmokeHarnessDeps = {}
): Promise<SmokeRunResult> {
  const lines: string[] = [];
  const diag = (deps.envDiagnostics ?? collectSmokeEnvDiagnostics)();
  lines.push(...formatSmokeEnvDiagnostics(diag));

  if (args.help) {
    lines.push(formatSmokeUsage());
    return { exitCode: 0, reports: [], lines };
  }

  if (args.unknown.length > 0) {
    lines.push(`Unknown or incomplete arguments: ${args.unknown.join(", ")}`);
    lines.push(formatSmokeUsage());
    return { exitCode: 1, reports: [], lines };
  }

  let targets: SmokeTarget[] = [];
  if (args.presets) {
    targets = OFFICIAL_BEER_SMOKE_PRESETS;
  } else {
    if (!args.brewery || !args.beer || !args.url) {
      lines.push("Missing required arguments: --brewery, --beer, and --url are required");
      lines.push("(or pass --presets).");
      lines.push(formatSmokeUsage());
      return { exitCode: 1, reports: [], lines };
    }
    targets = [
      {
        brewery: args.brewery,
        beer: args.beer,
        url: args.url
      }
    ];
  }

  const mode = args.browserOnly ? "browser-only" : "full-discovery";
  lines.push(`mode: ${mode}`);
  lines.push(`targets: ${targets.length}`);

  const reports: SmokeReport[] = [];
  for (const target of targets) {
    if (target.label) {
      lines.push(`--- preset: ${target.label} ---`);
    }
    const report =
      mode === "browser-only"
        ? await runBrowserOnlySmoke(target, deps)
        : await runFullDiscoverySmoke(target, deps);
    reports.push(report);
    for (const line of formatSmokeReport(report)) {
      lines.push(sanitizeSmokeOutputLine(line));
    }
  }

  const exitCode = exitCodeForReports(reports, targets);
  lines.push(`exit: ${exitCode}`);
  return { exitCode, reports, lines };
}

export async function mainSmokeOfficialBeerBrowser(
  argv: string[] = process.argv.slice(2),
  deps: SmokeHarnessDeps = {},
  io: { log?: (line: string) => void; error?: (line: string) => void } = {}
): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  try {
    const parsed = parseSmokeOfficialBeerBrowserArgs(argv);
    const result = await runOfficialBeerBrowserSmoke(parsed, deps);
    for (const line of result.lines) {
      log(sanitizeSmokeOutputLine(line));
    }
    return result.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "smoke_failed";
    error(sanitizeSmokeOutputLine(`smoke failed: ${message}`));
    for (const line of formatSmokeEnvDiagnostics(collectSmokeEnvDiagnostics())) {
      error(sanitizeSmokeOutputLine(line));
    }
    return 1;
  }
}
