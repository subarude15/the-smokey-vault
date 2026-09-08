/**
 * Guest-safe availability helpers (PR97 product behavior; not theme-specific).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  guestSpiritAvailabilityLabel,
  guestTapAvailabilityLabel,
  readAvailabilityPct,
  spiritGaugePct,
  tapGaugeForDisplay
} from "../client/src/guestAvailability.ts";

test("guestAvailability helpers prefer availability_pct and never invent pints for guests", () => {
  assert.equal(readAvailabilityPct({ availability_pct: 75 }), 75);
  assert.equal(readAvailabilityPct({ fill_level: 75 }), null);
  assert.equal(spiritGaugePct({ fill_level: 50 }, true), 50);
  assert.equal(spiritGaugePct({ availability_pct: 50, fill_level: 12 }, false), 50);
  assert.equal(spiritGaugePct({ fill_level: 50 }, false), null);
  assert.equal(guestSpiritAvailabilityLabel(0), "Empty");
  assert.equal(guestSpiritAvailabilityLabel(50), "Half");
  assert.equal(guestTapAvailabilityLabel(0), "Kicked");
  assert.equal(guestTapAvailabilityLabel(75), "¾");

  const guestTap = tapGaugeForDisplay({ availability_pct: 50 }, false, 19.5);
  assert.deepEqual(guestTap, { pct: 50, label: "Half" });
  assert.equal(JSON.stringify(guestTap).includes("pint"), false);

  const keeperTap = tapGaugeForDisplay({ remaining_l: 19.5, keg_size_l: 19.5 }, true, 19.5);
  assert.ok(keeperTap);
  assert.equal(keeperTap.pct, 100);
  assert.match(keeperTap.label, /pint/);
});
