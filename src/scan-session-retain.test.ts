/**
 * Shelf scan session must retain ownership until an explicit exit.
 * Covers navigation helpers + client wiring so successful saves never
 * auto-open BottleDetail / Import Review.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  finishScanningEndsShelfSession,
  restoreShelfSessionOnScanTab,
  reviewNowEndsShelfSession,
  scanTabSurface,
  shelfSessionAutoOpensBottleDetail,
  shelfSessionAutoOpensImportReview,
  isExplicitShelfSessionExit
} from "../client/src/scan-session-nav.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const sessionSrc = readFileSync(join(root, "client/src/ScanSession.tsx"), "utf8");
const scannerSrc = readFileSync(join(root, "client/src/ScanSessionScanner.tsx"), "utf8");

test("1 successful shelf-session scan remains in ScanSession (no auto BottleDetail)", () => {
  assert.equal(shelfSessionAutoOpensBottleDetail("added"), false);
  assert.equal(shelfSessionAutoOpensBottleDetail("updated"), false);
  assert.equal(scanTabSurface("active", false), "session");
  assert.ok(sessionSrc.includes("scan-session-result"));
  assert.ok(!sessionSrc.includes("handleScan("));
  assert.ok(!sessionSrc.includes("setScanDraft"));
  assert.ok(!sessionSrc.includes("navigate("));
});

test("2 successful scan does not automatically open BottleDetail", () => {
  assert.ok(appSrc.includes('shelfSessionMode === "active"'));
  assert.ok(appSrc.includes("Belt-and-suspenders"));
  assert.ok(sessionSrc.includes("View bottle"));
  // View bottle is explicit only
  assert.match(sessionSrc, /onViewBottle\(lastResult\.undo!\.table, lastResult\.undo!\.id\)/);
});

test("3 known bottle update remains in ScanSession", () => {
  assert.equal(shelfSessionAutoOpensBottleDetail("updated"), false);
  assert.ok(sessionSrc.includes("Already in vault ·"));
  assert.equal(scanTabSurface("active", true), "session");
});

test("4 camera resets after known bottle save", () => {
  // busy flip restarts the camera effect; statusHint is not a camera dependency
  assert.ok(scannerSrc.includes("}, [kind, paused, busy]);"));
  assert.ok(scannerSrc.includes('setStatus("Scanning…")'));
  assert.ok(scannerSrc.includes("statusHint is display-only"));
});

test("5-6 needs-review stays in session and does not auto-open Import Review", () => {
  assert.equal(shelfSessionAutoOpensImportReview("needs_review"), false);
  assert.ok(sessionSrc.includes("Added to review queue"));
  assert.ok(sessionSrc.includes("Review now"));
  assert.equal(reviewNowEndsShelfSession(), false);
});

test("7 Review now explicitly opens Import Review without ending session", () => {
  assert.ok(appSrc.includes("onOpenImport()"));
  assert.ok(appSrc.includes("keep session active so Scan restores it"));
  assert.equal(reviewNowEndsShelfSession(), false);
  assert.equal(isExplicitShelfSessionExit("review_now"), true);
});

test("8 View bottle explicitly opens BottleDetail", () => {
  assert.ok(appSrc.includes("onViewBottle={(table, id)"));
  assert.ok(appSrc.includes("setShelfViewItem"));
  assert.ok(appSrc.includes("openItem={shelfViewItem"));
  assert.ok(sessionSrc.includes("View bottle"));
});

test("9 bottom Scan tab opens scanner landing, not legacy Import Review by default", () => {
  assert.equal(scanTabSurface("idle", false), "landing");
  assert.equal(scanTabSurface("idle", true), "landing");
  assert.ok(appSrc.includes("Start shelf scan"));
  assert.ok(appSrc.includes("scan-landing-import"));
  assert.ok(appSrc.includes("Import review"));
  // Landing always shows shelf scan launch — miss no longer replaces the page
  assert.ok(appSrc.includes("scan-session-launch"));
  assert.ok(appSrc.includes("SINGLE SCAN"));
});

test("10 active shelf session is restored when returning to Scan", () => {
  assert.equal(restoreShelfSessionOnScanTab("active"), true);
  assert.equal(restoreShelfSessionOnScanTab("idle"), false);
  assert.ok(appSrc.includes("shelfSessionMode"));
  assert.ok(appSrc.includes('page === "scan" || shelfSessionMode !== "idle"'));
  assert.ok(appSrc.includes("scan-session-parked"));
  assert.ok(appSrc.includes("paused={!visible}"));
});

test("11 Finish scanning exits session correctly", () => {
  assert.equal(finishScanningEndsShelfSession(), true);
  assert.ok(sessionSrc.includes("Finish scanning"));
  assert.ok(appSrc.includes('onSessionModeChange("summary")') || appSrc.includes('onSessionModeChange("summary")'));
  assert.ok(appSrc.includes('onSessionModeChange("idle")'));
});

test("12 legacy single-scan workflow remains available on landing", () => {
  assert.ok(appSrc.includes("<Scanner onProduct={onProduct} onMiss={onMiss}/>") || appSrc.includes("Scanner onProduct={onProduct}"));
  assert.ok(appSrc.includes("One bottle at a time") || appSrc.includes("SINGLE SCAN"));
  // Legacy handleScan still navigates for non-session scans
  assert.ok(appSrc.includes("navigate(draft.moduleId)"));
});

test("13 patron permissions remain unchanged — scan is keeper-only", () => {
  assert.ok(appSrc.includes('GUEST_HIDDEN_PAGES = new Set(["scan"'));
  assert.ok(appSrc.includes("{admin && (page === \"scan\" || shelfSessionMode !== \"idle\")"));
});

test("14 Import Review / CSV tools remain on dedicated import page", () => {
  assert.ok(appSrc.includes('page === "import" && admin'));
  assert.ok(appSrc.includes("<ImportReview"));
  assert.ok(appSrc.includes('id:"import",label:"Import Review"'));
});

test("shelf session helpers reject auto navigation for every action", () => {
  for (const action of ["added", "updated", "needs_review", "duplicate", "failed"] as const) {
    assert.equal(shelfSessionAutoOpensBottleDetail(action), false);
    assert.equal(shelfSessionAutoOpensImportReview(action), false);
  }
});
