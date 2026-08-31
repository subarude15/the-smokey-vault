import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import {
  checkEnrichmentHealth,
  checkOllamaHealth,
  checkSearxngHealth,
  ollamaSafeHost,
} from "./ingestion/enrichment/health.js";
import { safeHostFromUrl, searxngSafeHost } from "./ingestion/web-search.js";
import {
  createTestAdminToken,
  createTestSessionToken,
  withTempDb,
} from "./test-helpers.js";

describe("enrichment dependency health", () => {
  const originalFetch = globalThis.fetch;
  let restoreFetch: (() => void) | undefined;

  after(() => {
    restoreFetch?.();
    globalThis.fetch = originalFetch;
  });

  function stubFetch(handler: typeof fetch) {
    restoreFetch?.();
    globalThis.fetch = handler;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
      restoreFetch = undefined;
    };
  }

  it("safeHostFromUrl strips credentials and query secrets", () => {
    assert.equal(
      safeHostFromUrl("https://user:secret@searx.example:8888/search?q=x&key=abc"),
      "searx.example:8888",
    );
    assert.equal(safeHostFromUrl("http://192.168.1.50:8888/search"), "192.168.1.50:8888");
    assert.equal(safeHostFromUrl("not-a-url"), null);
  });

  it("searxngSafeHost follows SEARXNG_URL then SMOKEY_SEARXNG_URL", () => {
    const prevSearx = process.env.SEARXNG_URL;
    const prevSmokey = process.env.SMOKEY_SEARXNG_URL;
    try {
      delete process.env.SEARXNG_URL;
      delete process.env.SMOKEY_SEARXNG_URL;
      assert.equal(searxngSafeHost(), "192.168.1.50:8888");

      process.env.SMOKEY_SEARXNG_URL = "http://smokey-host:9999/search";
      assert.equal(searxngSafeHost(), "smokey-host:9999");

      process.env.SEARXNG_URL = "http://primary:8080/search?token=secret";
      assert.equal(searxngSafeHost(), "primary:8080");
    } finally {
      if (prevSearx === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = prevSearx;
      if (prevSmokey === undefined) delete process.env.SMOKEY_SEARXNG_URL;
      else process.env.SMOKEY_SEARXNG_URL = prevSmokey;
    }
  });

  it("reachable SearXNG returns connected with latency", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await checkSearxngHealth();
    assert.equal(result.status, "connected");
    assert.equal(typeof result.latencyMs, "number");
    assert.equal(result.error, null);
    assert.ok(result.host);
    assert.ok(!result.host.includes("q="));
    assert.ok(!String(result.error ?? "").includes("secret"));
  });

  it("SearXNG timeout returns unreachable", async () => {
    stubFetch(async () => {
      const err = new Error("Aborted");
      err.name = "TimeoutError";
      throw err;
    });
    const result = await checkSearxngHealth();
    assert.equal(result.status, "unreachable");
    assert.equal(result.latencyMs, null);
    assert.match(String(result.error), /timeout|timed out/i);
  });

  it("SearXNG HTTP error returns unreachable", async () => {
    stubFetch(async () => new Response("down", { status: 503 }));
    const result = await checkSearxngHealth();
    assert.equal(result.status, "unreachable");
    assert.match(String(result.error), /503|HTTP/i);
  });

  it("SearXNG malformed JSON returns degraded without crashing", async () => {
    stubFetch(async () =>
      new Response("not-json{{{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await checkSearxngHealth();
    assert.equal(result.status, "degraded");
    assert.ok(result.error);
  });

  it("Ollama reachable returns connected", async () => {
    stubFetch(async (input) => {
      const url = String(input);
      assert.match(url, /\/api\/tags$/);
      return new Response(JSON.stringify({ models: [{ name: "llama3.2:3b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await checkOllamaHealth();
    assert.equal(result.status, "connected");
    assert.equal(typeof result.latencyMs, "number");
    assert.equal(result.error, null);
    assert.ok(result.host);
  });

  it("Ollama unavailable returns unreachable", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await checkOllamaHealth();
    assert.equal(result.status, "unreachable");
    assert.equal(result.latencyMs, null);
    assert.ok(result.error);
  });

  it("Ollama empty models list returns degraded", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await checkOllamaHealth();
    assert.equal(result.status, "degraded");
    assert.match(String(result.error), /no models/i);
  });

  it("checkEnrichmentHealth returns both services and checkedAt", async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "m" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const health = await checkEnrichmentHealth();
    assert.equal(health.searxng.status, "connected");
    assert.equal(health.ollama.status, "connected");
    assert.ok(health.checkedAt);
  });

  it("ollamaSafeHost never includes credentials", () => {
    const prev = process.env.OLLAMA_CHAT_URL;
    try {
      process.env.OLLAMA_CHAT_URL = "http://user:pass@ollama.local:11434/api/chat";
      const host = ollamaSafeHost();
      assert.equal(host, "ollama.local:11434");
      assert.ok(!host.includes("pass"));
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_CHAT_URL;
      else process.env.OLLAMA_CHAT_URL = prev;
    }
  });
});

describe("GET /api/admin/enrichment/health", () => {
  const originalFetch = globalThis.fetch;

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects unauthorized callers", async () => {
    await withTempDb(async () => {
      const app = createApp();
      await request(app).get("/api/admin/enrichment/health").expect(401);

      const patron = createTestSessionToken("patron-1");
      await request(app)
        .get("/api/admin/enrichment/health")
        .set("Authorization", `Bearer ${patron}`)
        .expect(403);
    });
  });

  it("allows keeper/admin and returns safe payload", async () => {
    await withTempDb(async () => {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.includes("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "llama" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const app = createApp();
      const admin = createTestAdminToken("keeper-1");
      const res = await request(app)
        .get("/api/admin/enrichment/health")
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);

      assert.equal(res.body.searxng.status, "connected");
      assert.equal(res.body.ollama.status, "connected");
      assert.ok(res.body.searxng.host);
      assert.ok(!JSON.stringify(res.body).includes("q=."));
      assert.ok(!JSON.stringify(res.body).toLowerCase().includes("password"));
      assert.ok(res.body.checkedAt);
    });
  });

  it("returns unreachable when SearXNG is down without stack traces", async () => {
    await withTempDb(async () => {
      globalThis.fetch = (async (input) => {
        const url = String(input);
        if (url.includes("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "llama" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new TypeError("fetch failed");
      }) as typeof fetch;

      const app = createApp();
      const admin = createTestAdminToken("keeper-1");
      const res = await request(app)
        .get("/api/admin/enrichment/health")
        .set("Authorization", `Bearer ${admin}`)
        .expect(200);

      assert.equal(res.body.searxng.status, "unreachable");
      assert.ok(res.body.searxng.error);
      assert.ok(!String(res.body.searxng.error).includes("at "));
      assert.ok(!String(res.body.searxng.error).includes("TypeError"));
    });
  });
});

describe("enrichment health UI contracts", () => {
  it("Settings mounts EnrichmentServicesHealth for keepers only via admin gate", async () => {
    const fs = await import("node:fs/promises");
    const appSrc = await fs.readFile(new URL("../client/src/App.tsx", import.meta.url), "utf8");
    assert.match(appSrc, /EnrichmentServicesHealth/);
    assert.match(appSrc, /case "settings"/);
    // Settings page itself is only rendered for admins
    assert.match(appSrc, /isAdmin[\s\S]*settings|settings[\s\S]*isAdmin/);
    const settingsNav = appSrc.includes('page === "settings"') && appSrc.includes("isAdmin");
    assert.ok(settingsNav, "settings navigation is admin-gated");
  });

  it("EnrichmentServicesHealth renders statuses and Check again", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../client/src/EnrichmentServicesHealth.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /Enrichment services/);
    assert.match(src, /SearXNG/);
    assert.match(src, /Ollama/);
    assert.match(src, /Check again/);
    assert.match(src, /\/api\/admin\/enrichment\/health/);
    assert.match(src, /Connected|connected/);
  });

  it("Enrichment maintenance shows non-blocking SearXNG warning", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../client/src/EnrichmentMaintenance.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /SearXNG is unavailable/);
    assert.match(src, /enrichment\/health/);
    // Queue actions still present — warning does not gate enqueue
    assert.match(src, /Run metadata for all/);
  });

  it("patron-facing EnrichmentPanel does not load health endpoint", async () => {
    const fs = await import("node:fs/promises");
    const panel = await fs.readFile(
      new URL("../client/src/EnrichmentPanel.tsx", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(panel, /enrichment\/health/);
  });
});
