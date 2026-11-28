/**
 * SearXNG search resilience: unresponsive_engines detection, backoff circuit breaker,
 * opt-in Brave Search API fallback, tasting-notes failure propagation, and Ollama URL config.
 * Uses fakes only — no live SearXNG, Brave, Ollama, or internet.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  isWebSearchError,
  probeSearxngConnectivity,
  resetSearxngSearchState,
  searchImageHitsFromSearx,
  searchWebHits,
  searxngBackoffState,
  WebSearchError
} from "./ingestion/web-search.js";
import {
  buildTastingNotesQueries,
  executeTastingNotesEnrichment
} from "./ingestion/enrichment/execute-tasting-notes.js";
import { classifySourceUrl } from "./ingestion/enrichment/tasting-notes-sources.js";
import { generateHouseTastingProfile } from "./ingestion/enrichment/tasting-notes-extract.js";
import type { BottleCandidate } from "./ingestion/candidate/types.js";

const originalFetch = globalThis.fetch;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;
const originalSmokeyBraveKey = process.env.SMOKEY_BRAVE_SEARCH_API_KEY;
const originalOllamaChatUrl = process.env.OLLAMA_CHAT_URL;
const originalOllamaHost = process.env.OLLAMA_HOST;

function restoreEnvAndFetch() {
  globalThis.fetch = originalFetch;
  resetSearxngSearchState();
  if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
  if (originalSmokeyBraveKey === undefined) delete process.env.SMOKEY_BRAVE_SEARCH_API_KEY;
  else process.env.SMOKEY_BRAVE_SEARCH_API_KEY = originalSmokeyBraveKey;
  if (originalOllamaChatUrl === undefined) delete process.env.OLLAMA_CHAT_URL;
  else process.env.OLLAMA_CHAT_URL = originalOllamaChatUrl;
  if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = originalOllamaHost;
}

function sampleCandidate(): BottleCandidate {
  const field = <T>(value: T) => ({
    value,
    confidence: 0.9,
    source: "catalog" as const
  });
  return {
    upc: field("080244009250"),
    name: field("Buffalo Trace Bourbon"),
    brand: field("Buffalo Trace"),
    product_type: field("spirit"),
    category: field("Bourbon"),
    abv: field(45),
    volume_ml: field(750),
    description: field(null),
    image_url: field(null),
    tasting_notes: field(null),
    provenance: []
  } as unknown as BottleCandidate;
}

describe("SearXNG unresponsive_engines detection and backoff", () => {
  afterEach(() => {
    restoreEnvAndFetch();
  });

  it("throws WebSearchError(engines_failed) when results is empty and unresponsive_engines is non-empty", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.SMOKEY_BRAVE_SEARCH_API_KEY;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [],
          unresponsive_engines: [
            ["google", "Suspended: access denied"],
            ["duckduckgo", "timeout"]
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;

    await assert.rejects(
      () => searchWebHits("buffalo trace bourbon official tasting notes", 5),
      (err: unknown) => {
        assert.ok(isWebSearchError(err));
        assert.equal(err.code, "engines_failed");
        assert.match(err.message, /google: Suspended: access denied/);
        assert.equal(err.unresponsiveEngines?.length, 2);
        return true;
      }
    );

    await assert.rejects(
      () => searchImageHitsFromSearx("buffalo trace bourbon bottle", 5),
      (err: unknown) => {
        assert.ok(isWebSearchError(err));
        assert.equal(err.code, "engines_failed");
        return true;
      }
    );
  });

  it("treats empty results with empty unresponsive_engines as a clean empty result", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ results: [], unresponsive_engines: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;

    const hits = await searchWebHits("obscure-nonexistent-bottle-xyz", 5);
    assert.deepEqual(hits, []);
    assert.equal(searxngBackoffState().consecutiveEngineFailures, 0);
  });

  it("returns hits normally when some engines are unresponsive but others returned results", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Buffalo Trace Official",
              content: "Vanilla, mint and molasses",
              url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html"
            }
          ],
          unresponsive_engines: [["google", "Suspended: access denied"]]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;

    const hits = await searchWebHits("buffalo trace", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Buffalo Trace Official");
    assert.equal(searxngBackoffState().consecutiveEngineFailures, 0);
  });

  it("enters backoff after 3 consecutive engines_failed responses and clears on healthy probe", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.SMOKEY_BRAVE_SEARCH_API_KEY;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          results: [],
          unresponsive_engines: [["google", "Suspended: access denied"]]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => searchWebHits(`query-${i}`, 5), WebSearchError);
    }
    assert.equal(fetchCalls, 3);
    assert.equal(searxngBackoffState().paused, true);

    // 4th call should short-circuit without hitting fetch
    await assert.rejects(
      () => searchWebHits("query-paused", 5),
      (err: unknown) => {
        assert.ok(isWebSearchError(err));
        assert.equal(err.code, "engines_failed");
        assert.match(err.message, /paused/i);
        return true;
      }
    );
    assert.equal(fetchCalls, 3);

    // Live health probe returning hits clears the backoff
    const probe = await probeSearxngConnectivity({
      fetch: (async () =>
        new Response(
          JSON.stringify({ results: [{ title: "Wikipedia", url: "https://en.wikipedia.org" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    });
    assert.equal(probe.resultCount, 1);
    assert.equal(searxngBackoffState().paused, false);
  });

  it("surfaces engines_failed in executeTastingNotesEnrichment errors instead of silent success", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.SMOKEY_BRAVE_SEARCH_API_KEY;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [],
          unresponsive_engines: [["google", "Suspended: access denied"]]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;

    const result = await executeTastingNotesEnrichment(
      sampleCandidate(),
      {},
      { wantOfficial: true, wantHouseProfile: false }
    );
    assert.equal(result.officialNotes, null);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /upstream engines failed/i);
  });
});

describe("Optional Brave Search API fallback", () => {
  afterEach(() => {
    restoreEnvAndFetch();
  });

  it("falls back to Brave web + image search when SearXNG engines fail and BRAVE_SEARCH_API_KEY is set", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-secret-key";
    const calledUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes("api.search.brave.com/res/v1/web/search")) {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-subscription-token"), "test-brave-secret-key");
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Buffalo Trace Distillery",
                  description: "Rich and complex, with hints of vanilla, toffee and candied fruit.",
                  url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html"
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("api.search.brave.com/res/v1/images/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html",
                properties: {
                  url: "https://www.buffalotracedistillery.com/images/bt-bottle.jpg",
                  width: 800,
                  height: 1200
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          results: [],
          unresponsive_engines: [["google", "Suspended: access denied"]]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const webHits = await searchWebHits("buffalo trace official tasting notes", 5);
    assert.equal(webHits.length, 1);
    assert.equal(webHits[0].title, "Buffalo Trace Distillery");
    assert.match(webHits[0].content, /vanilla/i);

    const imgHits = await searchImageHitsFromSearx("buffalo trace bourbon bottle", 5);
    assert.equal(imgHits.length, 1);
    assert.equal(imgHits[0].url, "https://www.buffalotracedistillery.com/images/bt-bottle.jpg");
    assert.equal(imgHits[0].width, 800);
    assert.equal(imgHits[0].height, 1200);
    assert.ok(calledUrls.some((u) => u.includes("api.search.brave.com/res/v1/web/search")));
    assert.ok(calledUrls.some((u) => u.includes("api.search.brave.com/res/v1/images/search")));
  });

  it("never calls Brave when SearXNG succeeds and never leaks API key on double failure", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "super-secret-brave-token";
    let braveCalled = false;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        braveCalled = true;
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(
        JSON.stringify({
          results: [{ title: "Local Hit", content: "From SearXNG", url: "https://example.com" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const hits = await searchWebHits("buffalo trace", 5);
    assert.equal(hits.length, 1);
    assert.equal(braveCalled, false);

    // Now fail both SearXNG and Brave — original WebSearchError propagates without leaking key
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        braveCalled = true;
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(
        JSON.stringify({
          results: [],
          unresponsive_engines: [["google", "Suspended: access denied"]]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    await assert.rejects(
      () => searchWebHits("buffalo trace", 5),
      (err: unknown) => {
        assert.ok(isWebSearchError(err));
        assert.equal(err.code, "engines_failed");
        assert.ok(!err.message.includes("super-secret-brave-token"));
        return true;
      }
    );
    assert.equal(braveCalled, true);
  });
});

describe("tasting-notes-extract Ollama URL configuration", () => {
  afterEach(() => {
    restoreEnvAndFetch();
  });

  it("respects OLLAMA_HOST / OLLAMA_CHAT_URL instead of a hardcoded IP", async () => {
    delete process.env.OLLAMA_CHAT_URL;
    process.env.OLLAMA_HOST = "http://custom-ollama.local:11434";
    let requestedUrl = "";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              aroma: "vanilla",
              palate: "caramel",
              finish: "oak",
              flavor_tags: ["vanilla", "caramel", "oak"]
            })
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const profile = await generateHouseTastingProfile({ candidate: sampleCandidate() });
    assert.equal(requestedUrl, "http://custom-ollama.local:11434/api/chat");
    assert.equal(profile.aroma, "vanilla");
  });
});

describe("Image SVG/icon filtering and empty-result Brave fallback", () => {
  afterEach(() => {
    restoreEnvAndFetch();
  });

  it("drops .svg devicon junk and falls back to Brave Image Search when zero usable photos remain", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-img-key";
    let braveImageCalled = false;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com/res/v1/images/search")) {
        braveImageCalled = true;
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html",
                properties: {
                  url: "https://www.buffalotracedistillery.com/images/bt-bottle.jpg",
                  width: 900,
                  height: 1200
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              img_src: "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/dynatrace/dynatrace-original.svg",
              url: "https://devicon.dev"
            },
            {
              img_src: "https://www.svgrepo.com/show/12345/bottle.svg",
              url: "https://www.svgrepo.com/svg/12345"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const hits = await searchImageHitsFromSearx("buffalo trace bourbon bottle", 5);
    assert.equal(braveImageCalled, true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "https://www.buffalotracedistillery.com/images/bt-bottle.jpg");
  });

  it("skips leading SVG icons and keeps real photo hits further down SearXNG results without calling Brave", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-img-key";
    let braveImageCalled = false;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        braveImageCalled = true;
        return new Response("should not be called", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              img_src: "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/dynatrace/dynatrace-original.svg",
              url: "https://devicon.dev"
            },
            {
              img_src: "https://www.buffalotracedistillery.com/media/bt.jpg",
              url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html",
              width: 800,
              height: 1200
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const hits = await searchImageHitsFromSearx("buffalo trace bourbon bottle", 1);
    assert.equal(braveImageCalled, false);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "https://www.buffalotracedistillery.com/media/bt.jpg");
  });
});

describe("Tasting-notes query hygiene and parent-company official domain matching", () => {
  it("builds clean 2-tier tasting-notes queries without UPC, generic spirit, or duplicated brand", () => {
    const queries = buildTastingNotesQueries(sampleCandidate());
    assert.equal(queries.length, 2);
    assert.equal(queries[0], "Buffalo Trace Bourbon official tasting notes");
    assert.equal(queries[1], "Buffalo Trace Bourbon tasting notes");
    assert.ok(!queries[0].includes("080244009250"));
    assert.ok(!/\bspirit\b/i.test(queries[0]));
  });

  it("falls back to Tier 2 tasting-notes query only when Tier 1 finds no authoritative source", async () => {
    const seenQueries: string[] = [];
    const result = await executeTastingNotesEnrichment(
      sampleCandidate(),
      {
        searchWebHits: async (query: string) => {
          seenQueries.push(query);
          if (seenQueries.length === 1) {
            return [
              {
                title: "Total Wine Buffalo Trace",
                content: "Retailer description",
                url: "https://www.totalwine.com/spirits/bourbon/buffalo-trace"
              }
            ];
          }
          return [
            {
              title: "Buffalo Trace Distillery — Tasting Notes",
              content: "Vanilla, mint, and molasses.",
              url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html"
            }
          ];
        },
        extractOfficial: async ({ authoritativeSnippets }) => {
          assert.match(authoritativeSnippets, /buffalotracedistillery\.com/);
          return {
            official_notes: "Vanilla, mint, and molasses.",
            source_url: "https://www.buffalotracedistillery.com/our-brands/buffalo-trace.html",
            confidence: "official"
          };
        }
      },
      { wantOfficial: true, wantHouseProfile: false }
    );
    assert.equal(seenQueries.length, 2);
    assert.equal(result.officialNotes, "Vanilla, mint, and molasses.");
    assert.equal(result.officialSourceType, "official");
  });

  it("classifies distinctive product-name domains as official under parent-company brands without false positives", () => {
    assert.equal(
      classifySourceUrl("https://www.eaglerare.com/bourbon", {
        brand: "Sazerac",
        name: "Eagle Rare 10 Year Kentucky Straight Bourbon"
      }),
      "official"
    );
    assert.equal(
      classifySourceUrl("https://www.lagavulin.com/en-us/whiskies/lagavulin-16", {
        brand: "Diageo",
        name: "Lagavulin 16 Year Single Malt Scotch"
      }),
      "official"
    );
    // Generic category domains must stay unknown, and retailers/UGC stay blocked
    assert.equal(
      classifySourceUrl("https://www.bourbon.com/reviews/eagle-rare", {
        brand: "Sazerac",
        name: "Eagle Rare 10 Year Kentucky Straight Bourbon"
      }),
      "unknown"
    );
    assert.equal(
      classifySourceUrl("https://www.totalwine.com/eaglerare", {
        brand: "Sazerac",
        name: "Eagle Rare 10 Year Kentucky Straight Bourbon"
      }),
      "retailer"
    );
  });
});
