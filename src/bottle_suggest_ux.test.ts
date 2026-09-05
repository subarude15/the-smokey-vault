import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOTTLE_SUGGEST_DEBOUNCE_MS,
  BOTTLE_SUGGEST_MAX_RESULTS,
  BOTTLE_SUGGEST_MIN_QUERY,
  clampActiveIndex,
  isAbortError,
  isCurrentRequest,
  mapSuggestKey,
  moveActiveIndex,
  runBottleSuggestSearch,
  shouldApplySearchResponse,
  shouldOpenBottleSuggest,
  suggestListId,
  suggestOptionId,
  suggestStatusId,
  suggestStatusText
} from "../client/src/bottleSuggestLogic.ts";

describe("BottleSuggest open / debounce constants", () => {
  it("A/W: opens after min length and skips empty or locked queries", () => {
    assert.equal(BOTTLE_SUGGEST_MIN_QUERY, 2);
    assert.equal(BOTTLE_SUGGEST_DEBOUNCE_MS, 280);
    assert.equal(BOTTLE_SUGGEST_MAX_RESULTS, 8);
    assert.equal(shouldOpenBottleSuggest("", ""), false);
    assert.equal(shouldOpenBottleSuggest("Y", ""), false);
    assert.equal(shouldOpenBottleSuggest("Ya", ""), true);
    assert.equal(shouldOpenBottleSuggest("Yards", "Yards"), false);
  });
});

describe("BottleSuggest abort + stale response guards", () => {
  it("D: AbortError is detected for silent handling", () => {
    assert.equal(isAbortError(new DOMException("Aborted", "AbortError")), true);
    assert.equal(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
    assert.equal(isAbortError(new Error("network")), false);
    assert.equal(isAbortError(null), false);
  });

  it("B/C: request-id guard rejects stale responses", () => {
    assert.equal(isCurrentRequest(3, 3), true);
    assert.equal(isCurrentRequest(2, 3), false);
    assert.equal(shouldApplySearchResponse(2, 3, false), false);
    assert.equal(shouldApplySearchResponse(3, 3, true), false);
    assert.equal(shouldApplySearchResponse(3, 3, false), true);
  });

  it("C: slower older response cannot overwrite newer results", async () => {
    const applied: string[] = [];
    let latest = 0;

    const slow = runBottleSuggestSearch({
      requestId: ++latest,
      getLatestRequestId: () => latest,
      signal: new AbortController().signal,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { results: ["old"] };
      },
      onSuccess: (data) => applied.push(data.results[0]!),
      onError: () => applied.push("error-old")
    });

    const fast = runBottleSuggestSearch({
      requestId: ++latest,
      getLatestRequestId: () => latest,
      signal: new AbortController().signal,
      fetch: async () => ({ results: ["new"] }),
      onSuccess: (data) => applied.push(data.results[0]!),
      onError: () => applied.push("error-new")
    });

    await Promise.all([slow, fast]);
    assert.deepEqual(applied, ["new"]);
  });

  it("B/D/X: aborted in-flight request does not commit", async () => {
    const applied: string[] = [];
    const controller = new AbortController();
    const pending = runBottleSuggestSearch({
      requestId: 1,
      getLatestRequestId: () => 1,
      signal: controller.signal,
      fetch: async (signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ results: ["late"] }), 50);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        return { results: ["late"] };
      },
      onSuccess: () => applied.push("success"),
      onError: () => applied.push("error")
    });
    controller.abort();
    await pending;
    assert.deepEqual(applied, []);
  });

  it("E: genuine network failure surfaces via onError", async () => {
    let errored = false;
    await runBottleSuggestSearch({
      requestId: 1,
      getLatestRequestId: () => 1,
      signal: new AbortController().signal,
      fetch: async () => {
        throw new Error("network down");
      },
      onSuccess: () => {
        throw new Error("should not succeed");
      },
      onError: () => {
        errored = true;
      }
    });
    assert.equal(errored, true);
  });
});

describe("BottleSuggest keyboard + active index", () => {
  it("G/H/U: ArrowDown/Up/Home/End move and clamp active index", () => {
    assert.equal(moveActiveIndex(-1, 3, "down"), 0);
    assert.equal(moveActiveIndex(0, 3, "down"), 1);
    assert.equal(moveActiveIndex(2, 3, "down"), 2);
    assert.equal(moveActiveIndex(1, 3, "up"), 0);
    assert.equal(moveActiveIndex(-1, 3, "up"), 2);
    assert.equal(moveActiveIndex(2, 3, "home"), 0);
    assert.equal(moveActiveIndex(0, 3, "end"), 2);
    assert.equal(moveActiveIndex(0, 0, "down"), -1);
    assert.equal(clampActiveIndex(5, 3), 2);
    assert.equal(clampActiveIndex(-1, 3), 0);
    assert.equal(clampActiveIndex(1, 0), -1);
  });

  it("I/J/K: Enter selects, Escape closes, Tab does not trap", () => {
    const open = { open: true, hasCustomAdd: true, activeIndex: 1, resultCount: 3 };
    assert.deepEqual(mapSuggestKey("ArrowDown", open), { type: "move", direction: "down" });
    assert.deepEqual(mapSuggestKey("ArrowUp", open), { type: "move", direction: "up" });
    assert.deepEqual(mapSuggestKey("Enter", open), { type: "select" });
    assert.deepEqual(mapSuggestKey("Escape", open), { type: "close" });
    assert.deepEqual(mapSuggestKey("Tab", open), { type: "none" });
    assert.deepEqual(mapSuggestKey("Enter", { ...open, activeIndex: -1, resultCount: 0 }), { type: "custom" });
    assert.deepEqual(mapSuggestKey("Enter", { ...open, activeIndex: -1, resultCount: 2 }), { type: "none" });
    assert.deepEqual(mapSuggestKey("ArrowDown", { ...open, open: false }), { type: "none" });
  });
});

describe("BottleSuggest ARIA helpers + status copy", () => {
  it("L/M/N/O: stable listbox/option ids and polite status text", () => {
    assert.equal(suggestListId("a1"), "bottle-suggest-list-a1");
    assert.equal(suggestOptionId("a1", 2), "bottle-suggest-option-a1-2");
    assert.equal(suggestStatusId("a1"), "bottle-suggest-status-a1");
    assert.equal(suggestStatusText("loading", 0), "Searching");
    assert.equal(suggestStatusText("ready", 5), "5 results");
    assert.equal(suggestStatusText("ready", 1), "1 result");
    assert.equal(suggestStatusText("empty", 0), "No matches");
    assert.equal(suggestStatusText("error", 0), "Search unavailable");
    assert.equal(suggestStatusText("idle", 0), "");
  });
});

describe("BottleSuggest custom-add honesty", () => {
  it("P/Q/R: custom add is a separate action type, not a vault hit", () => {
    const action = mapSuggestKey("Enter", {
      open: true,
      hasCustomAdd: true,
      activeIndex: -1,
      resultCount: 0
    });
    assert.deepEqual(action, { type: "custom" });
    const forbiddenFabrication = { source: "vault", product: { name: "Yards Mystery Beer" } };
    assert.notEqual(action.type, "select");
    assert.equal(forbiddenFabrication.source, "vault");
    assert.notEqual(action.type, forbiddenFabrication.source);
  });
});
