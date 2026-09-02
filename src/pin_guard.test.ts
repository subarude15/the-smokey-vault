import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIN_ATTEMPT_TTL_MS, PIN_FREE_ATTEMPTS, PIN_GLOBAL_FREE_ATTEMPTS, PIN_GLOBAL_KEY, PIN_MAX_WAIT_MS,
  pruneAttempts, recordFailure, recordUnlockFailure, requiredWaitMs, retryAfterMs,
  unlockWaitMs, type PinAttempts
} from "./pin_guard.js";

test("the first couple of typos cost nothing", () => {
  for (let fails = 0; fails <= PIN_FREE_ATTEMPTS; fails += 1) {
    assert.equal(requiredWaitMs(fails), 0, `${fails} failures should not wait`);
  }
});

test("each further failure doubles the wait, up to a ceiling", () => {
  assert.equal(requiredWaitMs(3), 1000);
  assert.equal(requiredWaitMs(4), 2000);
  assert.equal(requiredWaitMs(5), 4000);
  assert.equal(requiredWaitMs(6), 8000);
  assert.equal(requiredWaitMs(30), PIN_MAX_WAIT_MS, "the wait is capped so a keeper is never locked out");
});

test("a guessing spree cannot outrun the throttle", () => {
  let attempts: PinAttempts | undefined;
  let now = 1_000_000;
  for (let i = 0; i < 6; i += 1) {
    assert.equal(retryAfterMs(attempts, now), 0, "an allowed attempt");
    attempts = recordFailure(attempts, now);
    now += retryAfterMs(attempts, now);
  }
  assert.equal(attempts?.fails, 6);
  assert.equal(requiredWaitMs(attempts!.fails), 8000);
});

test("an attempt made too early is told how long to wait", () => {
  const now = 5_000_000;
  const attempts = { fails: 4, lastFailAt: now };
  assert.equal(retryAfterMs(attempts, now), 2000);
  assert.equal(retryAfterMs(attempts, now + 500), 1500, "credit for time already served");
  assert.equal(retryAfterMs(attempts, now + 2000), 0, "the wait elapsed");
  assert.equal(retryAfterMs(attempts, now + 9999), 0);
});

test("a stale streak is forgiven so yesterday's typos do not slow you down", () => {
  const attempts = { fails: 9, lastFailAt: 1_000 };
  assert.equal(retryAfterMs(attempts, 1_000 + PIN_ATTEMPT_TTL_MS), 0);
  assert.equal(recordFailure(attempts, 1_000 + PIN_ATTEMPT_TTL_MS).fails, 1, "the count restarts");
  assert.equal(recordFailure(attempts, 1_500).fails, 10, "a live streak keeps counting");
});

test("no attempts recorded means no waiting", () => {
  assert.equal(retryAfterMs(undefined, 42), 0);
  assert.equal(retryAfterMs({ fails: 0, lastFailAt: 0 }, 42), 0);
});

test("expired entries are dropped so the map cannot grow forever", () => {
  const now = 9_000_000;
  const store = new Map<string, PinAttempts>([
    ["1.1.1.1", { fails: 3, lastFailAt: now - PIN_ATTEMPT_TTL_MS - 1 }],
    ["2.2.2.2", { fails: 1, lastFailAt: now - 1000 }]
  ]);
  pruneAttempts(store, now);
  assert.deepEqual([...store.keys()], ["2.2.2.2"]);
});

test("unique spoofed IPs still hit the global PIN backstop", () => {
  const store = new Map<string, PinAttempts>();
  let now = 2_000_000;
  for (let i = 0; i < PIN_GLOBAL_FREE_ATTEMPTS; i += 1) {
    const ip = `203.0.113.${i}`;
    assert.equal(unlockWaitMs(store, ip, now), 0, "each new address is free until the global cap");
    recordUnlockFailure(store, ip, now);
    now += 5;
  }
  assert.ok(unlockWaitMs(store, "198.51.100.9", now) > 0, "the next unique address must wait");
  assert.equal(store.get(PIN_GLOBAL_KEY)?.fails, PIN_GLOBAL_FREE_ATTEMPTS);
});
