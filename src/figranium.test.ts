/**
 * Figranium client unit tests (mocked fetch).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
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

test("isFigraniumConfigured requires BASE_URL and API key (no defaults)", () => {
  stashEnv();
  delete process.env.FIGRANIUM_API_KEY;
  delete process.env.FIGRANIUM_BASE_URL;
  assert.equal(isFigraniumConfigured(), false);
  assert.equal(getFigraniumBaseUrl(), "");

  process.env.FIGRANIUM_API_KEY = "test-key";
  assert.equal(isFigraniumConfigured(), false);

  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com/";
  assert.equal(isFigraniumConfigured(), true);
  assert.equal(getFigraniumBaseUrl(), "https://fig.example.com");
});

test("figraniumHealth reads /api/health", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
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

test("figraniumRunTask posts variables and returns typed success", async () => {
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
  assert.equal(result.kind, "success");
  if (result.kind === "success") {
    assert.equal(result.httpStatus, 200);
    assert.equal((result.data as { plcbItem?: string }).plcbItem, "000004766");
  }
});

test("figraniumRunTask returns unavailable when unconfigured", async () => {
  stashEnv();
  delete process.env.FIGRANIUM_API_KEY;
  delete process.env.FIGRANIUM_BASE_URL;
  const result = await figraniumRunTask("task_123");
  assert.equal(result.kind, "unavailable");
});

test("figraniumRunTask classifies 401 as auth_error (non-retryable)", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "INVALID_API_KEY" }), { status: 401 })) as typeof fetch;
  const result = await figraniumRunTask("task_123");
  assert.equal(result.kind, "auth_error");
  if (result.kind === "auth_error") {
    assert.equal(result.httpStatus, 401);
  }
});

test("figraniumRunTask classifies 403 as auth_error", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 })) as typeof fetch;
  const result = await figraniumRunTask("task_123");
  assert.equal(result.kind, "auth_error");
  if (result.kind === "auth_error") assert.equal(result.httpStatus, 403);
});

test("figraniumRunTask classifies 502 as retryable_error", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  globalThis.fetch = (async () =>
    new Response("bad gateway", { status: 502 })) as typeof fetch;
  const result = await figraniumRunTask("task_123");
  assert.equal(result.kind, "retryable_error");
  if (result.kind === "retryable_error") {
    assert.equal(result.httpStatus, 502);
  }
});

test("figraniumRunTask classifies timeouts as retryable_error", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  globalThis.fetch = (async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as typeof fetch;
  const result = await figraniumRunTask("task_123");
  assert.equal(result.kind, "retryable_error");
});

test("figraniumRunTask rejects malformed envelope as invalid_response", async () => {
  stashEnv();
  process.env.FIGRANIUM_API_KEY = "test-key";
  process.env.FIGRANIUM_BASE_URL = "https://fig.example.com";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(["not", "an", "object"]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch;
  const result = await figraniumRunTask("task_123");
  assert.equal(result.kind, "invalid_response");
  if (result.kind === "invalid_response") assert.equal(result.httpStatus, 200);
});
