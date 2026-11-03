/**
 * Keeper tap reassignment: move/swap beers by exchanging tap_number.
 * Preserves row id so enrichment, reviews, and votes stay with the beer.
 */
import { db } from "./db.js";
import { isTapEmpty, TAP_COUNT, tapTitle } from "./catalog.js";

export type TapRow = Record<string, unknown>;

export type TapReassignOk = {
  ok: true;
  noop: boolean;
  swapped: boolean;
  from_tap_number: number;
  to_tap_number: number;
  taps: TapRow[];
};

export type TapReassignErr = {
  ok: false;
  statusCode: number;
  error: string;
};

export type TapReassignResult = TapReassignOk | TapReassignErr;

export function parseTapDestination(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > TAP_COUNT) return null;
  return n;
}

function loadTapById(id: number): TapRow | undefined {
  return db.prepare("SELECT * FROM taps WHERE id=?").get(id) as TapRow | undefined;
}

function loadTapByNumber(tapNumber: number): TapRow | undefined {
  return db.prepare("SELECT * FROM taps WHERE tap_number=?").get(tapNumber) as TapRow | undefined;
}

function loadTapsOrdered(): TapRow[] {
  return db.prepare("SELECT * FROM taps ORDER BY tap_number ASC").all() as TapRow[];
}

/**
 * Atomically move the beer on `sourceId` to `toTapNumber`.
 * Empty destination → move (origin becomes empty slot).
 * Occupied destination → swap tap numbers (both beers keep their ids).
 * Same tap → no-op success.
 */
export function reassignTap(sourceId: number, toTapNumber: number): TapReassignResult {
  if (!Number.isFinite(sourceId) || sourceId <= 0 || !Number.isInteger(sourceId)) {
    return { ok: false, statusCode: 400, error: "Invalid tap id" };
  }
  if (parseTapDestination(toTapNumber) == null) {
    return { ok: false, statusCode: 400, error: `Tap number must be between 1 and ${TAP_COUNT}` };
  }

  const source = loadTapById(sourceId);
  if (!source) return { ok: false, statusCode: 404, error: "Tap not found" };
  if (isTapEmpty(source)) {
    return { ok: false, statusCode: 400, error: "Cannot move an empty tap" };
  }

  const fromTapNumber = Number(source.tap_number);
  if (fromTapNumber === toTapNumber) {
    return {
      ok: true,
      noop: true,
      swapped: false,
      from_tap_number: fromTapNumber,
      to_tap_number: toTapNumber,
      taps: loadTapsOrdered()
    };
  }

  const dest = loadTapByNumber(toTapNumber);
  if (!dest) return { ok: false, statusCode: 404, error: "Destination tap not found" };

  const destId = Number(dest.id);
  const swapped = !isTapEmpty(dest);
  // Temporary slot avoids UNIQUE(tap_number) collisions mid-swap.
  // ponytail: negative temps are fine while TAP_COUNT stays small; upgrade to a deferred
  // unique or staging column if tap slots ever grow past a few dozen.
  const tempTapNumber = -fromTapNumber;

  const tx = db.transaction(() => {
    db.prepare("UPDATE taps SET tap_number=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(tempTapNumber, sourceId);
    db.prepare("UPDATE taps SET tap_number=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(fromTapNumber, destId);
    db.prepare("UPDATE taps SET tap_number=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(toTapNumber, sourceId);
  });

  try {
    tx();
  } catch (err) {
    return {
      ok: false,
      statusCode: 500,
      error: err instanceof Error ? err.message : "Tap reassignment failed"
    };
  }

  return {
    ok: true,
    noop: false,
    swapped,
    from_tap_number: fromTapNumber,
    to_tap_number: toTapNumber,
    taps: loadTapsOrdered()
  };
}

/** Destination picker labels for Keeper UI / tests. */
export function tapDestinationLabel(tap: TapRow): string {
  const num = Number(tap.tap_number);
  if (isTapEmpty(tap)) return `Tap ${num} · Empty`;
  return `Tap ${num} · ${tapTitle(tap)}`;
}
