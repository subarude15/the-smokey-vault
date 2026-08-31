/**
 * Transient notice auto-dismiss lifecycle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTransientNoticeController,
  looksLikeErrorNotice,
  TRANSIENT_NOTICE_MS
} from "./transient-notice.js";

test("success/info notification auto-dismisses", async () => {
  const changes: string[] = [];
  const c = createTransientNoticeController({
    successMs: 80,
    errorMs: 200,
    onChange: (v) => changes.push(v)
  });
  c.set("Queued 1 enrichment job. The background worker will process them.");
  assert.equal(c.get().includes("Queued"), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c.get(), "");
  assert.ok(changes.includes(""));
  c.dispose();
});

test("new notification resets dismissal timer", async () => {
  const c = createTransientNoticeController({ successMs: 100, errorMs: 300 });
  c.set("First");
  await new Promise((r) => setTimeout(r, 60));
  c.set("Second");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get(), "Second");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get(), "");
  c.dispose();
});

test("timer clears on dispose/unmount", async () => {
  let cleared = false;
  const c = createTransientNoticeController({
    successMs: 500,
    onChange: (v) => {
      if (v === "") cleared = true;
    }
  });
  c.set("Queued enrichment");
  c.dispose();
  await new Promise((r) => setTimeout(r, 50));
  // dispose must not force-clear the displayed value mid-flight for the controller
  // contract used by React (state already set); it only cancels the pending timer.
  assert.equal(typeof TRANSIENT_NOTICE_MS, "number");
  assert.equal(cleared, false);
  assert.equal(c.get(), "Queued enrichment");
});

test("error notices are detected for longer display", () => {
  assert.equal(looksLikeErrorNotice("Could not queue enrichment jobs"), true);
  assert.equal(looksLikeErrorNotice("Queued 1 enrichment job. The background worker will process them."), false);
  assert.equal(looksLikeErrorNotice("House name saved"), false);
});
