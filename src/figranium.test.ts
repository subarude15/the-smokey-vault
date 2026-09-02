/**
 * Figranium client unit tests (mocked fetch).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  FIGRANIUM_DEFAULT_BASE_URL,
  figraniumHealth,
  figraniumRunTask,
  getFigraniumBaseUrl,
  isFigraniumConfigured
} from "./figranium.js";

const originalFetch = globalThis.fetch;
const envKeys = [
  "FIGRANIUM_API_KEY",
  "FIGRANIUM_BASE_URL",
  "FIGRANIUM_TIMEOUT_MS"
] as const;
const savedEnv = new Map<string, string | undefined>();

function stashEnv() {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
}

function restoreEnv() {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
}

afterEach(() => {
  restoreEnv();
});

test("isFigraniumConfigured requires API key", () => {
  stashEnv();
  delete process.env.FIGRANIUM_API_KEY;
  assert.equal(isFigraniumConfigured(), false);
  process.env.FIGRANIUM_API_KEY = "test-key";
  assert.equal(isFigraniumConfigured(), true);
  assert.equal(getFigraniumBaseUrl(), FIGRANIUM_DEFAULT_BASE_URL);
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com/";
  assert.equal(getFigraniumBaseUrl(), "https://fig.example.com");
});

test("figraniumHealth reads /api/health", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  let called = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    called = String(input);
    return new Response(JSON.stringify({ status: "ok", uptime: 1, storage: "json" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  const health = await figraniumHealth();
  assert.equal(health.ok, true);
  assert.equal(health.status, "ok");
  assert.match(called, /\/api\/health$/);
});

test("figraniumRunTask posts variables to /api/tasks/:id/api", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  let method = "";
  let url = "";
  let body = "";
  let auth = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    method = String(init?.method ?? "GET");
    url = String(input);
    body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    auth = headers.get("Authorization") ?? "";
    return new Response(
      JSON.stringify({
        outcome: "success",
        data: { matched: true, plcbItem: "000004766" }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await figraniumRunTask("task_123", {
    variables: { plcbItem: "000004766", pdpUrl: "https://example.com/product/000004766" }
  });
  assert.equal(method, "POST");
  assert.equal(url, "https://fig.example.com/api/tasks/task_123/api");
  assert.match(auth, /^Bearer test-key$/);
  assert.match(body, /000004766/);
  assert.equal(result?.outcome, "success");
  assert.equal((result?.data as { plcbItem?: string } | undefined)?.plcbItem, "000004766");
});

test("figraniumRunTask returns null when unconfigured or HTTP fails", async () => {
  stashEnv();
  delete process.env.FIGRANIUM_API_KEY;
  assert.equal(await figraniumRunTask("task_123"), null);

  process.env.FIGRANIUM_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "INVALID_API_KEY" }), { status: 401 })) as typeof fetch;
  assert.equal(await figraniumRunTask("task_123"), null);
});
