/**
 * PR145 — Keeper build identifier derived from build metadata (not committed constants).
 * Covers stamped production metadata, missing SHA, missing PR, malformed fallback, and Keeper-only exposure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SMOKEY_TEST_NO_LISTEN = "1";

const { buildDateStamp, buildDateLabel, getBuildInfo } = await import("./build-info.js");
const { app, createTestAdminToken } = await import("./server.js");

const FIXED_NOW = new Date("2026-03-04T12:00:00Z");

test("buildDateStamp / buildDateLabel format and fall back safely", () => {
  assert.equal(buildDateStamp("2026-09-08"), "090826");
  assert.equal(buildDateStamp("2026-12-31"), "123126");
  assert.equal(buildDateStamp("nope"), "000000");
  assert.equal(buildDateLabel("2026-09-08"), "Sep 8, 2026");
  assert.equal(buildDateLabel("bad"), "bad");
});

test("fully stamped production metadata renders build, PR, and SHA", () => {
  const info = getBuildInfo({ BUILD_DATE: "2026-09-08", BUILD_PR: "145", GIT_SHA: "2351d81abcdef" });
  assert.equal(info.build, "090826.145");
  assert.equal(info.date, "2026-09-08");
  assert.equal(info.pr, 145);
  assert.equal(info.sha, "2351d81", "SHA truncated to 7 chars");
  assert.equal(info.subtitle, "Sep 8, 2026 · through PR145 · 2351d81");
  assert.equal(info.stamped, true);
});

test("GITHUB_SHA is accepted as the SHA source (CI env)", () => {
  const info = getBuildInfo({ BUILD_DATE: "2026-09-08", BUILD_PR: "145", GITHUB_SHA: "abc1234def" });
  assert.equal(info.sha, "abc1234");
});

test("missing optional SHA still produces a valid stamped identifier", () => {
  const info = getBuildInfo({ BUILD_DATE: "2026-09-08", BUILD_PR: "145" });
  assert.equal(info.build, "090826.145");
  assert.equal(info.sha, null);
  assert.equal(info.subtitle, "Sep 8, 2026 · through PR145");
  assert.equal(info.stamped, true);
});

test("missing PR/build metadata falls back to a deterministic local/dev identifier", () => {
  const info = getBuildInfo({}, FIXED_NOW);
  assert.equal(info.pr, null);
  assert.equal(info.sha, null);
  assert.equal(info.date, "2026-03-04", "dev fallback uses today's date");
  assert.equal(info.build, "030426.dev");
  assert.equal(info.subtitle, "Mar 4, 2026 · local dev build");
  assert.equal(info.stamped, false);
});

test("malformed metadata falls back safely (no crash, no fake PR)", () => {
  const info = getBuildInfo({ BUILD_PR: "not-a-number", BUILD_DATE: "2026/09/08" }, FIXED_NOW);
  assert.equal(info.pr, null, "non-numeric PR is ignored");
  assert.equal(info.date, "2026-03-04", "malformed date falls back to today");
  assert.equal(info.build, "030426.dev");
  assert.equal(info.stamped, false);
});

test("a date-only stamp (e.g. tag build with no PR) is still marked stamped", () => {
  const info = getBuildInfo({ BUILD_DATE: "2026-09-08", GIT_SHA: "deadbee" });
  assert.equal(info.pr, null);
  assert.equal(info.build, "090826.dev");
  assert.equal(info.subtitle, "Sep 8, 2026 · local dev build · deadbee");
  assert.equal(info.stamped, true);
});

test("GET /api/admin/build is Keeper-only", async () => {
  const guest = await app.inject({ method: "GET", url: "/api/admin/build" });
  assert.equal(guest.statusCode, 401, "guests cannot read build info");

  const keeper = await app.inject({
    method: "GET",
    url: "/api/admin/build",
    headers: { authorization: `Bearer ${createTestAdminToken()}` }
  });
  assert.equal(keeper.statusCode, 200);
  const body = keeper.json() as { build: string; subtitle: string; pr: number | null; stamped: boolean };
  assert.match(body.build, /^\d{6}\.(dev|\d+)$/);
  assert.ok(typeof body.subtitle === "string" && body.subtitle.length > 0);
  assert.equal(body.build, getBuildInfo(process.env).build);
});
