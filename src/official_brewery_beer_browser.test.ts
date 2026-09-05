/**
 * Official brewery beer browser adapter — Figranium stubs only.
 * Never hits a live Figranium server or FWGS task IDs.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  assertOfficialBreweryHttpUrl,
  getOfficialBeerBrowserTaskId,
  isOfficialBeerBrowserConfigured,
  renderOfficialBreweryBeerPage,
  type OfficialBeerBrowserDeps
} from "./official_brewery_beer_browser.js";
import type { FigraniumRunResult } from "./figranium.js";

const ENV_KEYS = [
  "FIGRANIUM_API_KEY",
  "FIGRANIUM_BASE_URL",
  "FIGRANIUM_OFFICIAL_BEER_TASK_ID",
  "FIGRANIUM_FWGS_IMAGE_TASK_ID",
  "FIGRANIUM_FWGS_IMAGE_FETCH_TASK_ID",
  "FIGRANIUM_FWGS_RESOLVER_TASK_ID"
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function stashEnv(): void {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureOfficialBrowserEnv(): void {
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  process.env.FIGRANIUM_OFFICIAL_BEER_TASK_ID = "task_official_beer_render";
}

afterEach(() => {
  restoreEnv();
});

stashEnv();

test("adapter A. sends configured official-beer task ID only", async () => {
  configureOfficialBrowserEnv();
  let seenTaskId = "";
  let seenVariables: Record<string, unknown> | undefined;
  const runTask: NonNullable<OfficialBeerBrowserDeps["runTask"]> = async (
    taskId,
    options
  ) => {
    seenTaskId = taskId;
    seenVariables = options.variables as Record<string, unknown>;
    return {
      kind: "success",
      httpStatus: 200,
      envelope: { outcome: "success", success: true },
      data: {
        finalUrl: "https://yardsbrewing.com/beers/brawler",
        title: "Brawler",
        html: "<html><body><h1>Brawler</h1></body></html>",
        links: []
      }
    } satisfies FigraniumRunResult;
  };

  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards Brewing Co.",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    { runTask }
  );

  assert.equal(outcome.status, "ok");
  assert.equal(seenTaskId, "task_official_beer_render");
  assert.equal(seenTaskId, getOfficialBeerBrowserTaskId());
  assert.notEqual(seenTaskId, process.env.FIGRANIUM_FWGS_IMAGE_TASK_ID);
  assert.deepEqual(Object.keys(seenVariables || {}).sort(), [
    "beerName",
    "breweryName",
    "url"
  ]);
});

test("adapter B. missing FIGRANIUM_OFFICIAL_BEER_TASK_ID is a safe no-op", async () => {
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  delete process.env.FIGRANIUM_OFFICIAL_BEER_TASK_ID;
  assert.equal(isOfficialBeerBrowserConfigured(), false);
  let called = false;
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () => {
        called = true;
        return { kind: "unavailable", message: "should not run" };
      }
    }
  );
  assert.equal(called, false);
  assert.equal(outcome.status, "unavailable");
});

test("adapter C/D. requires finalUrl and rejects non-http(s)", async () => {
  configureOfficialBrowserEnv();
  const missing = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: { html: "<html></html>" }
        }) as FigraniumRunResult
    }
  );
  assert.equal(missing.status, "invalid_result");

  assert.throws(() => assertOfficialBreweryHttpUrl("ftp://yardsbrewing.com/x", "yardsbrewing.com"));
});

test("adapter E. empty HTML and links rejected", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: {
            finalUrl: "https://yardsbrewing.com/beers",
            html: "   ",
            links: []
          }
        }) as FigraniumRunResult
    }
  );
  assert.equal(outcome.status, "invalid_result");
});

test("adapter F/G. timeout and task failure map cleanly", async () => {
  configureOfficialBrowserEnv();
  const timeout = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () => ({
        kind: "retryable_error",
        message: "Figranium network/timeout failure"
      })
    }
  );
  assert.equal(timeout.status, "timeout");

  const failed = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () => ({
        kind: "invalid_response",
        httpStatus: 500,
        message: "Figranium HTTP 500"
      })
    }
  );
  assert.equal(failed.status, "invalid_result");
});

test("adapter H. off-domain final URL rejected", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: {
            finalUrl: "https://retailer.example/brawler",
            html: "<html><h1>Brawler</h1></html>"
          }
        }) as FigraniumRunResult
    }
  );
  assert.equal(outcome.status, "off_domain");
});

test("adapter I. off-domain candidate links are stripped", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: {
            finalUrl: "https://yardsbrewing.com/beers",
            html: "<html><body>Beers</body></html>",
            links: [
              { href: "https://yardsbrewing.com/beers/brawler", text: "Brawler" },
              { href: "https://untappd.com/brawler", text: "Untappd" },
              { href: "https://beeradvocate.com/brawler", text: "BA" }
            ]
          }
        }) as FigraniumRunResult
    }
  );
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.equal(outcome.page.links.length, 1);
  assert.equal(outcome.page.links[0]?.href, "https://yardsbrewing.com/beers/brawler");
});

test("adapter J. does not log API key or full HTML", async () => {
  configureOfficialBrowserEnv();
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await renderOfficialBreweryBeerPage(
      {
        url: "https://yardsbrewing.com/beers",
        breweryName: "Yards",
        beerName: "Brawler",
        registeredDomain: "yardsbrewing.com"
      },
      {
        runTask: async () =>
          ({
            kind: "success",
            httpStatus: 200,
            envelope: { outcome: "success", success: true },
            data: {
              finalUrl: "https://yardsbrewing.com/beers",
              html: "<html><body>SECRET_FULL_HTML_SHOULD_NOT_APPEAR</body></html>"
            }
          }) as FigraniumRunResult
      }
    );
  } finally {
    console.info = original;
  }
  const joined = lines.join("\n");
  assert.equal(joined.includes("test-key"), false);
  assert.equal(joined.includes("SECRET_FULL_HTML_SHOULD_NOT_APPEAR"), false);
});

test("adapter K. html-only result accepted", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: {
            finalUrl: "https://yardsbrewing.com/beers/brawler",
            title: "Brawler",
            html: "<html><body><h1>Brawler</h1></body></html>"
          }
        }) as FigraniumRunResult
    }
  );
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.ok(outcome.page.html?.includes("Brawler"));
  assert.equal(outcome.page.links.length, 0);
});

test("adapter L. links-only result accepted", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: {
            finalUrl: "https://yardsbrewing.com/beers",
            title: "Beers",
            links: [{ href: "https://yardsbrewing.com/beers/brawler", text: "Brawler" }]
          }
        }) as FigraniumRunResult
    }
  );
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.equal(outcome.page.html, null);
  assert.equal(outcome.page.links.length, 1);
});

test("adapter M. relative links normalize to absolute same-domain URLs", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () =>
        ({
          kind: "success",
          httpStatus: 200,
          envelope: { outcome: "success", success: true },
          data: {
            finalUrl: "https://yardsbrewing.com/beers",
            html: "<html><body>Beers</body></html>",
            links: [
              { href: "/beers/brawler", text: "Brawler" },
              { href: "brawler", text: "Relative" }
            ]
          }
        }) as FigraniumRunResult
    }
  );
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;
  assert.ok(
    outcome.page.links.every((link) => link.href.startsWith("https://yardsbrewing.com/"))
  );
  assert.ok(
    outcome.page.links.some((link) => link.href.includes("/beers/brawler"))
  );
});

test("adapter N. auth_error maps to error status", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () => ({
        kind: "auth_error",
        httpStatus: 401,
        message: "Figranium unauthorized"
      })
    }
  );
  assert.equal(outcome.status, "error");
  if (outcome.status === "ok") return;
  assert.match(outcome.reason, /unauthorized|auth/i);
});

test("adapter O. unavailable task maps to unavailable status", async () => {
  configureOfficialBrowserEnv();
  const outcome = await renderOfficialBreweryBeerPage(
    {
      url: "https://yardsbrewing.com/beers",
      breweryName: "Yards",
      beerName: "Brawler",
      registeredDomain: "yardsbrewing.com"
    },
    {
      runTask: async () => ({
        kind: "unavailable",
        message: "Figranium unreachable"
      })
    }
  );
  assert.equal(outcome.status, "unavailable");
});
