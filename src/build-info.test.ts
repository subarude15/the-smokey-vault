/**
 * PR145 — Keeper build/version identifier: formatting, env overrides, and Keeper-only exposure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { BUILD_PR, BUILD_DATE, buildNumber, buildDateLabel, getBuildInfo } = await import("./build-info.js");
const { app, createTestAdminToken } = await import("./server.js");

test("buildNumber renders MMDDYY.PR", () => {
  assert.equal(buildNumber("2026-09-08", 145), "090826.145");
  assert.equal(buildNumber("2026-12-31", 200), "123126.200");
  assert.equal(buildNumber("bad-date", 5), "000000.5");
});

test("buildDateLabel renders a human date and falls back safely", () => {
  assert.equal(buildDateLabel("2026-09-08"), "Sep 8, 2026");
  assert.equal(buildDateLabel("2026-01-01"), "Jan 1, 2026");
  assert.equal(buildDateLabel("nope"), "nope");
});

test("getBuildInfo derives everything from the committed constants by default", () => {
  const info = getBuildInfo({});
  assert.equal(info.pr, BUILD_PR);
  assert.equal(info.date, BUILD_DATE);
  assert.equal(info.build, buildNumber(BUILD_DATE, BUILD_PR));
  assert.match(info.subtitle, new RegExp(`through PR${BUILD_PR}$`));
  assert.equal(info.sha, null, "no SHA unless provided");
});

test("getBuildInfo honors env overrides for CI stamping", () => {
  const info = getBuildInfo({ BUILD_PR: "150", BUILD_DATE: "2026-10-01", GIT_SHA: "2351d81abcdef" });
  assert.equal(info.pr, 150);
  assert.equal(info.build, "100126.150");
  assert.equal(info.subtitle, "Oct 1, 2026 · through PR150");
  assert.equal(info.sha, "2351d81", "short SHA is truncated to 7 chars");
});

test("malformed env overrides fall back to the committed constants", () => {
  const info = getBuildInfo({ BUILD_PR: "-4", BUILD_DATE: "   " });
  assert.equal(info.pr, BUILD_PR);
  assert.equal(info.date, BUILD_DATE);
});

test("GET /api/admin/build is Keeper-only and returns the build info", async () => {
  const guest = await app.inject({ method: "GET", url: "/api/admin/build" });
  assert.equal(guest.statusCode, 401, "guests cannot read build info");

  const keeper = await app.inject({
    method: "GET",
    url: "/api/admin/build",
    headers: { authorization: `Bearer ${createTestAdminToken()}` }
  });
  assert.equal(keeper.statusCode, 200);
  const body = keeper.json() as { build: string; subtitle: string; pr: number };
  assert.equal(body.build, getBuildInfo(process.env).build);
  assert.equal(body.pr, getBuildInfo(process.env).pr);
  assert.match(body.subtitle, /through PR\d+/);
});
