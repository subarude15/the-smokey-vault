/**
 * PR133 — authenticated Keeper 401 clears session and signals Guest handoff.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  api,
  ApiError,
  clearToken,
  downloadExport,
  onKeeperAuthRejected,
  setToken,
  tokenExists,
  UNREACHABLE_STATUS
} from "../client/src/api.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const apiSrc = readFileSync(join(root, "client/src/api.ts"), "utf8");

const originalFetch = globalThis.fetch;
const unsubscribers: Array<() => void> = [];

function jsonResponse(status: number, body: unknown = { error: "Unauthorized" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

beforeEach(() => {
  clearToken();
});

afterEach(() => {
  while (unsubscribers.length) unsubscribers.pop()?.();
  clearToken();
  globalThis.fetch = originalFetch;
});

function listen(): { count: number; calls: number[] } {
  const state = { count: 0, calls: [] as number[] };
  unsubscribers.push(onKeeperAuthRejected(() => {
    state.count += 1;
    state.calls.push(Date.now());
  }));
  return state;
}

test("setToken / clearToken / tokenExists round-trip", () => {
  assert.equal(tokenExists(), false);
  setToken("keeper-token");
  assert.equal(tokenExists(), true);
  clearToken();
  assert.equal(tokenExists(), false);
});

test("authenticated request + 401 emits auth rejection, still throws ApiError 401", async () => {
  const rejected = listen();
  setToken("expired-token");
  globalThis.fetch = (async () => jsonResponse(401, { error: "Invalid token" })) as typeof fetch;

  await assert.rejects(
    () => api("/settings"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /Invalid token|Unauthorized|Request failed/);
      return true;
    }
  );
  assert.equal(rejected.count, 1);
  assert.equal(tokenExists(), false);
});

test("authenticated request + non-401 failure does not emit auth rejection", async () => {
  const rejected = listen();
  setToken("keeper-token");
  for (const status of [400, 403, 404, 409, 500]) {
    clearToken();
    setToken("keeper-token");
    rejected.count = 0;
    globalThis.fetch = (async () => jsonResponse(status, { error: `fail-${status}` })) as typeof fetch;
    await assert.rejects(() => api("/settings"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(rejected.count, 0, `status ${status} must not emit auth rejection`);
    assert.equal(tokenExists(), true, `token must remain after ${status}`);
  }
});

test("request without Keeper token + 401 does not trigger session handoff", async () => {
  const rejected = listen();
  clearToken();
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("authorization"), false);
    return jsonResponse(401);
  }) as typeof fetch;

  await assert.rejects(() => api("/house"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(rejected.count, 0);
  assert.equal(tokenExists(), false);
});

test("network / unreachable failure does not trigger auth rejection", async () => {
  const rejected = listen();
  setToken("keeper-token");
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  await assert.rejects(() => api("/settings"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, UNREACHABLE_STATUS);
    assert.match(error.message, /Cannot reach the vault server/);
    return true;
  });
  assert.equal(rejected.count, 0);
  assert.equal(tokenExists(), true);
});

test("aborted request preserves abort behavior without auth rejection", async () => {
  const rejected = listen();
  setToken("keeper-token");
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_input, init) => {
    if (init?.signal?.aborted) {
      const err = new DOMException("Aborted", "AbortError");
      throw err;
    }
    return jsonResponse(200, {});
  }) as typeof fetch;

  await assert.rejects(() => api("/settings", { signal: controller.signal }));
  assert.equal(rejected.count, 0);
  assert.equal(tokenExists(), true);
});

test("after token clear, subsequent request does not send Authorization", async () => {
  setToken("expired-token");
  let sawAuth: boolean | null = null;
  let phase = 0;
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (phase === 0) {
      assert.equal(headers.get("authorization"), "Bearer expired-token");
      phase = 1;
      return jsonResponse(401);
    }
    sawAuth = headers.has("authorization");
    return jsonResponse(200, { ok: true });
  }) as typeof fetch;

  await assert.rejects(() => api("/settings"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(tokenExists(), false);

  const body = await api<{ ok: boolean }>("/house");
  assert.deepEqual(body, { ok: true });
  assert.equal(sawAuth, false);
});

test("multiple concurrent 401s notify once and remain idempotent", async () => {
  const rejected = listen();
  setToken("expired-token");
  globalThis.fetch = (async () => jsonResponse(401)) as typeof fetch;

  const results = await Promise.allSettled([
    api("/settings"),
    api("/messages/unread"),
    api("/house")
  ]);

  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof ApiError);
    assert.equal(result.reason.status, 401);
  }
  assert.equal(rejected.count, 1);
  assert.equal(tokenExists(), false);
});

test("downloadExport authenticated 401 uses the same auth-rejection path", async () => {
  const rejected = listen();
  setToken("expired-token");
  globalThis.fetch = (async () => jsonResponse(401)) as typeof fetch;

  await assert.rejects(() => downloadExport("json"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Export failed/);
    return true;
  });
  assert.equal(rejected.count, 1);
  assert.equal(tokenExists(), false);
});

test("App wires auth rejection to existing handToGuest (not a second reset path)", () => {
  assert.match(appSrc, /onKeeperAuthRejected/);
  assert.match(
    appSrc,
    /useEffect\(\(\) => onKeeperAuthRejected\(handToGuest\),\s*\[handToGuest\]\)/
  );
  assert.match(appSrc, /const handToGuest = useCallback\(\(\) => \{/);
  assert.match(appSrc, /clearToken\(\);\s*setAdmin\(false\);/s);
  // Idle lock and Lock Bar still converge on the same handToGuest.
  assert.match(appSrc, /KIOSK_IDLE_MS/);
  assert.match(appSrc, /setTimeout\(handToGuest,\s*KIOSK_IDLE_MS\)/);
  assert.match(appSrc, /onClick=\{handToGuest\}/);
  // API owns 401 detection; App does not re-implement status checks for logout.
  assert.doesNotMatch(appSrc, /status\s*===\s*401[\s\S]{0,80}handToGuest/);
});

test("api layer detects 401 centrally and preserves ApiError contract", () => {
  assert.match(apiSrc, /onKeeperAuthRejected/);
  assert.match(apiSrc, /notifyKeeperAuthRejected/);
  assert.match(apiSrc, /response\.status === 401/);
  assert.match(apiSrc, /rejectKeeperSessionIfAuthenticated\(sentAuth\)/);
  assert.match(apiSrc, /throw new ApiError/);
  assert.match(apiSrc, /downloadExport[\s\S]*rejectKeeperSessionIfAuthenticated\(sentAuth\)/s);
});
