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
  // Schema is INTEGER NOT NULL UNIQUE with no CHECK(1..7), so negatives are legal.
  // Use a per-row reserved temp far below the public 1..TAP_COUNT range so concurrent
  // moves from different sources cannot collide on the same negative.
  const tempTapNumber = temporaryTapNumberForSwap(sourceId);

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
    // better-sqlite3 rolls the transaction back on throw — assignments stay as before.
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

/** Reserved temporary tap_number used inside the swap transaction (never 1..TAP_COUNT). */
export function temporaryTapNumberForSwap(sourceId: number): number {
  return -(1_000_000 + sourceId);
}

/** Tap numbers shown in the Keeper destination picker (all slots except the current one). */
export function tapReassignDestinationNumbers(currentTapNumber: number): number[] {
  const current = Number(currentTapNumber);
  return Array.from({ length: TAP_COUNT }, (_, index) => index + 1).filter((n) => n !== current);
}

/** Destination picker labels for Keeper UI / tests. */
export function tapDestinationLabel(tap: TapRow): string {
  const num = Number(tap.tap_number);
  if (isTapEmpty(tap)) return `Tap ${num} · Empty`;
  return `Tap ${num} · ${tapTitle(tap)}`;
}

/** True when every tap row uses a public 1..TAP_COUNT slot (no leftover swap temps). */
export function tapsHaveOnlyPublicNumbers(rows: TapRow[]): boolean {
  return rows.every((row) => {
    const n = Number(row.tap_number);
    return Number.isInteger(n) && n >= 1 && n <= TAP_COUNT;
  });
}
