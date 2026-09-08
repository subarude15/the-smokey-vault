import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  guestSpiritAvailabilityLabel,
  guestTapAvailabilityLabel,
  readAvailabilityPct,
  spiritGaugePct,
  tapGaugeForDisplay
} from "../client/src/guestAvailability.ts";
import { DEFAULT_KEG_L, isTapEmpty } from "../client/src/catalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardSrc = readFileSync(join(root, "client/src/TapSpiritInventoryCard.tsx"), "utf8");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/tap-spirit-card.css"), "utf8");

test("Guest tap presentation consumes coarse availability rather than raw keg math", () => {
  const guest = { brewery_batch: "House IPA", availability_pct: 50 };
  assert.equal(isTapEmpty(guest), false);
  assert.equal(readAvailabilityPct(guest), 50);
  assert.equal(guestTapAvailabilityLabel(50), "Half");
  assert.deepEqual(tapGaugeForDisplay(guest, false, DEFAULT_KEG_L), { pct: 50, label: "Half" });

  assert.match(cardSrc, /const guestPct = !admin \? readAvailabilityPct\(item\) : null/);
  assert.match(cardSrc, /guestTapAvailabilityLabel\(guestPct\)/);
  assert.doesNotMatch(cardSrc, /remaining_l\s*\/\s*keg_size_l/);
});

test("Guest spirit presentation consumes coarse availability rather than raw fill", () => {
  const guest = { availability_pct: 25 };
  assert.equal(readAvailabilityPct(guest), 25);
  assert.equal(guestSpiritAvailabilityLabel(25), "¼");
  assert.equal(spiritGaugePct(guest, false), 25);

  assert.match(cardSrc, /const guestPct = !admin \? readAvailabilityPct\(item\) : null/);
  assert.match(cardSrc, /const gaugePct = spiritGaugePct\(item, admin\)/);
  assert.match(cardSrc, /guestSpiritAvailabilityLabel\(guestPct\)/);
});

test("exact operational quantities are only rendered inside Keeper branches", () => {
  assert.match(cardSrc, /keeper=\{admin \? `\$\{remaining\.toFixed\(1\)\} L/);
  assert.match(cardSrc, /\{admin \? <div className="domain-card-ops-meta">/);
  assert.match(cardSrc, /item\.stock_count/);
  assert.match(cardSrc, /item\.shelf_location/);
  assert.doesNotMatch(cardSrc, /UPC/);
});

test("homebrew detection is explicit and routes to Guest Brewery Lab", () => {
  assert.match(cardSrc, /\^homebrew\$\/i\.test\(text\(item\.source_type\)\)/);
  assert.doesNotMatch(cardSrc, /source_type\s*!==\s*["']Commercial["']/);
  assert.match(appSrc, /openBreweryLab=\{\(\) => navigate\("brewery"\)\}/);
  assert.doesNotMatch(cardSrc, /brews/);
});

test("empty taps stay visible and are not inferred from raw remaining liters", () => {
  assert.equal(isTapEmpty({ brewery_batch: "None" }), true);
  assert.equal(isTapEmpty({ brewery_batch: "" }), true);
  assert.equal(isTapEmpty({ brewery_batch: "House Lager", remaining_l: 0 }), false);
  assert.match(cardSrc, /const empty = isTapEmpty\(item\)/);
  assert.match(cardSrc, /Line currently empty/);
});

test("Keeper tap controls reuse existing pour and established clear flow", () => {
  assert.match(cardSrc, /remaining_l: pourPint\(remaining\)/);
  assert.match(cardSrc, /onClearTap/);
  assert.match(appSrc, /async function clearTap\(item: Item\)/);
  assert.match(appSrc, /JSON\.stringify\(emptyTapBeerFields\(\)\)/);
  assert.match(appSrc, /onClearTap=\{\(\) => \{ void clearTap\(item\); \}\}/);
});

test("Keeper spirit controls reuse current mutation semantics", () => {
  assert.match(cardSrc, /fill_level: pourSpirit\(item\.fill_level\)/);
  assert.match(cardSrc, /const nextSpirit = admin \? openNextSpirit\(item\) : null/);
  assert.match(cardSrc, /blocked_from_ordering: blocked \? 0 : 1/);
  assert.match(cardSrc, /Allow for patrons/);
  assert.match(cardSrc, /Block from patrons/);
  assert.match(cardSrc, /BLOCKED_RIBBON_LABEL/);
});

test("inline Keeper controls are separate from the detail-opening target", () => {
  assert.match(cardSrc, /className="domain-card-main"[\s\S]*role="button"[\s\S]*onClick=\{onOpenDetail\}/);
  assert.match(cardSrc, /className="keeper-card-controls" onClick=\{stop\}/);
  assert.match(cardSrc, /onEdit/);
});

test("PR135 is wired only into Tap and Spirit collection cards; BottleDetail remains", () => {
  assert.match(appSrc, /if \(module\.id === "taps"\) \{[\s\S]*<TapInventoryCard/);
  assert.match(appSrc, /if \(module\.id === "spirits"\) \{[\s\S]*<SpiritInventoryCard/);
  assert.match(appSrc, /function BottleDetail\(/);
  assert.match(appSrc, /<BottleDetail/);
});

test("card CSS preserves responsive touch ergonomics", () => {
  assert.match(cssSrc, /\.keeper-card-controls \.secondary\{[^}]*min-height:42px/);
  assert.match(cssSrc, /@media\(max-width:720px\)[\s\S]*\.keeper-card-controls \.secondary\{[^}]*min-height:46px/);
  assert.match(cssSrc, /\.homebrew-link\{[^}]*min-height:38px/);
});
