/**
 * Narrow Figranium adapter for official-brewery beer page rendering.
 *
 * Static PR103 discovery stays first. This module only renders URLs that already
 * belong to the established official brewery registered domain. It is not a
 * generic browser proxy and must never share FWGS task IDs.
 */
import { z } from "zod";
import {
  figraniumRunTask,
  isFigraniumConfigured,
  type FigraniumRunResult
} from "./figranium.js";
import {
  hostMatchesDiscoveredDomain,
  registeredDomain
} from "./ingestion/enrichment/official-domain.js";
import { NetworkSafetyError, parseSafeHttpUrl } from "./network_safety.js";

export const OFFICIAL_BEER_BROWSER_TIMEOUT_MS = 25_000;
export const OFFICIAL_BEER_BROWSER_MAX_PAGES = 3;

const OfficialBeerBrowserTaskDataSchema = z
  .object({
    finalUrl: z.string().min(1).optional(),
    final_url: z.string().min(1).optional(),
    title: z.string().nullable().optional(),
    html: z.string().nullable().optional(),
    links: z
      .array(
        z.object({
          href: z.string().min(1),
          text: z.string().nullable().optional()
        })
      )
      .optional()
  })
  .passthrough();

export type OfficialBeerBrowserTaskData = z.infer<typeof OfficialBeerBrowserTaskDataSchema>;

export type OfficialBeerBrowserInput = {
  url: string;
  breweryName: string;
  beerName: string;
  registeredDomain: string;
};

export type OfficialBeerBrowserPage = {
  finalUrl: string;
  title: string | null;
  html: string | null;
  links: Array<{ href: string; text: string | null }>;
};

export type OfficialBeerBrowserStatus =
  | "ok"
  | "unavailable"
  | "timeout"
  | "off_domain"
  | "invalid_result"
  | "error";

export type OfficialBeerBrowserOutcome =
  | { status: "ok"; page: OfficialBeerBrowserPage }
  | {
      status: Exclude<OfficialBeerBrowserStatus, "ok">;
      reason: string;
    };

export type OfficialBeerBrowserDeps = {
  runTask?: typeof figraniumRunTask;
  taskId?: string | null;
  timeoutMs?: number;
};

function trimEnv(value: string | undefined | null): string {
  return String(value ?? "").trim();
}

function logBrowser(event: string, details: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...details }));
}

/** Dedicated brewery-render task — never reuse FWGS task IDs. */
export function getOfficialBeerBrowserTaskId(
  env: NodeJS.ProcessEnv = process.env
): string {
  return trimEnv(env.FIGRANIUM_OFFICIAL_BEER_TASK_ID);
}

export function isOfficialBeerBrowserConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isFigraniumConfigured() && Boolean(getOfficialBeerBrowserTaskId(env));
}

export function assertOfficialBreweryHttpUrl(
  rawUrl: string,
  expectedRegisteredDomain: string
): URL {
  const domain = registeredDomain(expectedRegisteredDomain);
  if (!domain) {
    throw new NetworkSafetyError("Official brewery domain is required.", "invalid_url");
  }
  const parsed = parseSafeHttpUrl(rawUrl);
  if (!hostMatchesDiscoveredDomain(parsed.hostname, domain)) {
    throw new NetworkSafetyError("URL left the official brewery domain.", "redirect");
  }
  return parsed;
}

function normalizeLinks(
  links: Array<{ href: string; text?: string | null }> | undefined,
  registered: string,
  baseUrl: string
): Array<{ href: string; text: string | null }> {
  if (!links?.length) return [];
  const out: Array<{ href: string; text: string | null }> = [];
  for (const link of links) {
    const hrefRaw = String(link.href || "").trim();
    if (!hrefRaw) continue;
    try {
      const abs = parseSafeHttpUrl(hrefRaw, baseUrl);
      if (!hostMatchesDiscoveredDomain(abs.hostname, registered)) continue;
      out.push({
        href: abs.toString(),
        text: link.text == null ? null : String(link.text).trim() || null
      });
    } catch {
      // ignore unsafe / malformed link
    }
  }
  return out;
}

function mapTaskFailure(
  result: Exclude<FigraniumRunResult<unknown>, { kind: "success" }>
): OfficialBeerBrowserOutcome {
  if (result.kind === "unavailable") {
    return { status: "unavailable", reason: result.message };
  }
  if (result.kind === "retryable_error") {
    const timeout = /timeout|timed out|abort/i.test(result.message);
    return {
      status: timeout ? "timeout" : "error",
      reason: result.message
    };
  }
  if (result.kind === "auth_error") {
    return { status: "error", reason: result.message };
  }
  return { status: "invalid_result", reason: result.message };
}

/**
 * Render one official-domain brewery URL via Figranium.
 * Caller must already gate eligibility (static-first, JS-shell evidence, etc.).
 */
export async function renderOfficialBreweryBeerPage(
  input: OfficialBeerBrowserInput,
  deps: OfficialBeerBrowserDeps = {}
): Promise<OfficialBeerBrowserOutcome> {
  const taskId = trimEnv(deps.taskId ?? getOfficialBeerBrowserTaskId());
  if (!taskId || !isFigraniumConfigured()) {
    logBrowser("official_beer_browser_skip", {
      reason: "task_unconfigured",
      domain: input.registeredDomain
    });
    return { status: "unavailable", reason: "official_beer_browser_unconfigured" };
  }

  let safeUrl: URL;
  try {
    safeUrl = assertOfficialBreweryHttpUrl(input.url, input.registeredDomain);
  } catch (error) {
    const reason =
      error instanceof NetworkSafetyError ? error.message : "invalid_official_url";
    logBrowser("official_beer_browser_off_domain", {
      reason,
      domain: input.registeredDomain
    });
    return { status: "off_domain", reason };
  }

  logBrowser("official_beer_browser_start", {
    domain: input.registeredDomain,
    host: safeUrl.hostname
  });

  const runTask = deps.runTask ?? figraniumRunTask;
  const timeoutMs = deps.timeoutMs ?? OFFICIAL_BEER_BROWSER_TIMEOUT_MS;

  let result: FigraniumRunResult<OfficialBeerBrowserTaskData>;
  try {
    result = await runTask(taskId, {
      variables: {
        url: safeUrl.toString(),
        beerName: input.beerName,
        breweryName: input.breweryName
      },
      timeoutMs,
      schema: OfficialBeerBrowserTaskDataSchema
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : "browser_error";
    logBrowser("official_beer_browser_error", {
      domain: input.registeredDomain,
      reason: message
    });
    return { status: "error", reason: message };
  }

  if (result.kind !== "success") {
    const mapped = mapTaskFailure(result);
    const event =
      mapped.status === "timeout"
        ? "official_beer_browser_timeout"
        : mapped.status === "unavailable"
          ? "official_beer_browser_skip"
          : "official_beer_browser_error";
    logBrowser(event, {
      domain: input.registeredDomain,
      reason: mapped.status === "ok" ? "unexpected" : mapped.reason
    });
    return mapped;
  }

  const data = result.data;
  const finalRaw = String(data.finalUrl || data.final_url || "").trim();
  if (!finalRaw) {
    logBrowser("official_beer_browser_error", {
      domain: input.registeredDomain,
      reason: "missing_final_url"
    });
    return { status: "invalid_result", reason: "missing_final_url" };
  }

  let finalUrl: URL;
  try {
    finalUrl = assertOfficialBreweryHttpUrl(finalRaw, input.registeredDomain);
  } catch {
    logBrowser("official_beer_browser_off_domain", {
      domain: input.registeredDomain,
      reason: "final_url_off_domain"
    });
    return { status: "off_domain", reason: "final_url_off_domain" };
  }

  const html = data.html == null ? null : String(data.html);
  const links = normalizeLinks(data.links, input.registeredDomain, finalUrl.toString());
  if (!html?.trim() && links.length === 0) {
    logBrowser("official_beer_browser_error", {
      domain: input.registeredDomain,
      reason: "empty_render"
    });
    return { status: "invalid_result", reason: "empty_render" };
  }

  return {
    status: "ok",
    page: {
      finalUrl: finalUrl.toString(),
      title: data.title == null ? null : String(data.title).trim() || null,
      html: html?.trim() ? html : null,
      links
    }
  };
}
