/**
 * PR #91 — bottle-detail Back returns to the originating collection.
 * Focused regressions for origin resolution, history sync, and App wiring.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCollectionHistoryState,
  buildDetailHistoryState,
  isBottleDetailHistoryState,
  naturalCollectionForModule,
  pushBottleDetailHistory,
  resolveDetailBackTarget,
  shouldCloseDetailOnPopState,
  shouldPushDetailHistory,
  syncHistoryAfterClosingDetail
} from "../client/src/bottle-detail-nav.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");

function inventorySlice(): string {
  const start = appSrc.indexOf("function Inventory(");
  assert.ok(start >= 0, "Inventory component present");
  const end = appSrc.indexOf("\nfunction BottleDetail(", start);
  assert.ok(end > start, "BottleDetail follows Inventory");
  return appSrc.slice(start, end);
}

test("A. Wine collection origin resolves Back to wines", () => {
  assert.equal(resolveDetailBackTarget("wines", "wines"), "wines");
  assert.notEqual(resolveDetailBackTarget("wines", "wines"), "dashboard");
});

test("B. Spirit collection origin resolves Back to spirits", () => {
  assert.equal(resolveDetailBackTarget("spirits", "spirits"), "spirits");
  assert.notEqual(resolveDetailBackTarget("spirits", "spirits"), "dashboard");
});

test("C. Packaged Beer origin resolves Back to packaged_beer", () => {
  assert.equal(resolveDetailBackTarget("packaged_beer", "packaged_beer"), "packaged_beer");
  assert.notEqual(resolveDetailBackTarget("packaged_beer", "packaged_beer"), "dashboard");
});

test("D. Inventory keeps search/filter state while detail is open", () => {
  const slice = inventorySlice();
  assert.match(slice, /const \[search,setSearch\] = useState\(""\)/);
  assert.match(slice, /const \[maker,setMaker\] = useState\("All"\)/);
  assert.match(slice, /const \[kind,setKind\] = useState\("All"\)/);
  assert.match(slice, /const \[viewing,setViewing\] = useState/);
  // Detail is rendered inside Inventory (early return), so filter useState survives Back.
  assert.match(slice, /if \(viewing\) \{\s*return <BottleDetail/s);
  assert.match(slice, /openBottleDetail/);
  assert.match(slice, /closeBottleDetail/);
});

test("E. Safe fallback uses natural collection, never Dashboard", () => {
  assert.equal(resolveDetailBackTarget(null, "wines"), "wines");
  assert.equal(resolveDetailBackTarget(undefined, "spirits"), "spirits");
  assert.equal(resolveDetailBackTarget("", "packaged_beer"), "packaged_beer");
  assert.equal(resolveDetailBackTarget("dashboard", "wines"), "wines");
  assert.equal(naturalCollectionForModule("wines"), "wines");
  assert.notEqual(resolveDetailBackTarget(null, "wines"), "dashboard");
  assert.notEqual(resolveDetailBackTarget(undefined, "spirits"), "dashboard");
});

test("F. Explicit nav overrides detail — Home uses navigate/setPage", () => {
  assert.match(appSrc, /const navigate = \(next: string\) => \{\s*setPage\(next\);/s);
  assert.match(appSrc, /ensureCollection=\{\(\) => navigate\(module\.id\)\}/);
  assert.match(appSrc, /navigate\("dashboard"\)|navigate\(item\.id\)/);
});

test("G. Browser back / popstate closes detail without history loops", () => {
  const history: { state: unknown; stack: unknown[] } = {
    state: { page: "wines" },
    stack: []
  };
  const api = {
    get state() { return history.state; },
    pushState(state: unknown) {
      history.stack.push(history.state);
      history.state = state;
    },
    replaceState(state: unknown) {
      history.state = state;
    }
  };

  assert.equal(shouldPushDetailHistory(api.state, "wines", 42), true);
  pushBottleDetailHistory(api, "wines", 42);
  assert.equal(isBottleDetailHistoryState(api.state), true);
  assert.deepEqual(api.state, buildDetailHistoryState("wines", 42));

  // Re-opening the same bottle must not push a duplicate entry.
  pushBottleDetailHistory(api, "wines", 42);
  assert.equal(history.stack.length, 1);

  // Visible Back replaces detail state (does not history.back()).
  syncHistoryAfterClosingDetail(api, "wines");
  assert.deepEqual(api.state, buildCollectionHistoryState("wines"));
  assert.equal(history.stack.length, 1);

  assert.equal(shouldCloseDetailOnPopState({ page: "wines" }, "wines"), true);
  assert.equal(shouldCloseDetailOnPopState(buildDetailHistoryState("wines", 42), "wines"), false);
  assert.equal(shouldCloseDetailOnPopState(buildDetailHistoryState("spirits", 7), "wines"), true);

  const slice = inventorySlice();
  assert.match(slice, /addEventListener\("popstate"/);
  assert.match(slice, /shouldCloseDetailOnPopState/);
  assert.match(slice, /syncHistoryAfterClosingDetail/);
  assert.doesNotMatch(slice, /window\.history\.back\(\)/);
  assert.doesNotMatch(appSrc, /onBack=\{[^}]*history\.back\(/);
});

test("H. Taps / Homebrew navigation wiring remains dedicated comparators", () => {
  const slice = inventorySlice();
  assert.match(slice, /module\.id === "taps"/);
  assert.match(slice, /module\.id === "brews"/);
  assert.match(slice, /compareBrews/);
  assert.match(slice, /tap_number/);
  assert.doesNotMatch(slice, /closeBottleDetail[\s\S]*navigate\("dashboard"\)/);
  assert.doesNotMatch(appSrc, /ensureCollection=\{\(\) => navigate\("dashboard"\)\}/);
});

test("PR #91 App wires collection-safe Back control", () => {
  assert.match(appSrc, /aria-label=\{`Back to \$\{module\.label\}`\}/);
  assert.match(appSrc, /back-button/);
  assert.match(appSrc, /onBack=\{closeBottleDetail\}/);
  assert.match(inventorySlice(), /savedScrollRef/);
});
