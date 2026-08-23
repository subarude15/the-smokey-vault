export type PinAttempts = {
  /** Consecutive failures since the last success. */
  fails: number;
  /** Epoch ms of the most recent failure. */
  lastFailAt: number;
};

/** The first couple of fat-fingered entries cost nothing. */
export const PIN_FREE_ATTEMPTS = 2;
/** Waiting caps out here, so a legitimate keeper is never locked out for long. */
export const PIN_MAX_WAIT_MS = 60_000;
/** Failures older than this are forgiven, so yesterday's typos don't slow you down. */
export const PIN_ATTEMPT_TTL_MS = 15 * 60_000;

/**
 * Escalating delay rather than a hard lock. A hard lock keyed on IP is a denial of
 * service against the owner whenever a proxy collapses every visitor into one address,
 * so instead each failure past the free ones doubles the wait: 1s, 2s, 4s ... 60s.
 * Guessing all 10,000 four-digit PINs at a one-minute floor takes about a week, while
 * someone who simply mistyped waits a moment and gets in.
 */
export function requiredWaitMs(fails: number) {
  if (fails <= PIN_FREE_ATTEMPTS) return 0;
  const doublings = fails - PIN_FREE_ATTEMPTS - 1;
  return Math.min(1000 * 2 ** doublings, PIN_MAX_WAIT_MS);
}

/** Milliseconds still to wait, or 0 when an attempt is allowed right now. */
export function retryAfterMs(attempts: PinAttempts | undefined, now: number) {
  if (!attempts || !attempts.fails) return 0;
  if (now - attempts.lastFailAt >= PIN_ATTEMPT_TTL_MS) return 0;
  const elapsed = now - attempts.lastFailAt;
  return Math.max(0, requiredWaitMs(attempts.fails) - elapsed);
}

/** Folds one more failure in, forgiving a stale streak first. */
export function recordFailure(attempts: PinAttempts | undefined, now: number): PinAttempts {
  const stale = !attempts || now - attempts.lastFailAt >= PIN_ATTEMPT_TTL_MS;
  return { fails: stale ? 1 : attempts!.fails + 1, lastFailAt: now };
}

/** Drops entries nothing is waiting on, so the map cannot grow without bound. */
export function pruneAttempts(store: Map<string, PinAttempts>, now: number) {
  for (const [key, attempts] of store) {
    if (now - attempts.lastFailAt >= PIN_ATTEMPT_TTL_MS) store.delete(key);
  }
  return store;
}
