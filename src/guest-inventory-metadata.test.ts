/**
 * PR #93 — guest-facing inventory metadata visibility.
 * Guests must not see UPC or raw stock/bottle/packaged counts on Spirits,
 * Wine, or Packaged Beer cards/detail. Keepers still see them. No API/data changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");

function inventoryCardSlice(): string {
  const marker = "inventory-card inventory-card-button";
  const idx = appSrc.indexOf(marker);
  assert.ok(idx >= 0, "shared inventory collection card present");
  const start = appSrc.lastIndexOf("<button", idx);
  const end = appSrc.indexOf("</button>", start);
  assert.ok(start >= 0 && end > start, "inventory card button bounds");
  return appSrc.slice(start, end + "</button>".length);
}

function bottleDetailSlice(): string {
  const start = appSrc.indexOf("function BottleDetail");
  assert.ok(start >= 0, "BottleDetail present");
  const end = appSrc.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, "BottleDetail bounds");
  return appSrc.slice(start, end);
}

test("A. Guest spirits card hides UPC", () => {
  const slice = inventoryCardSlice();
  assert.match(slice, /admin && item\.upc \? <span>UPC/);
  assert.doesNotMatch(slice, /(?<!admin && )\{item\.upc \? <span>UPC/);
});

test("B. Guest spirits card hides stock/bottle count", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /admin && module\.id === "spirits" \? <span className="stock-chip">\{spiritStockLabel\(item\.stock_count\)\}/
  );
  assert.doesNotMatch(
    slice,
    /(?<!admin && )module\.id === "spirits" \? <span className="stock-chip">/
  );
});

test("C. Keeper spirits card still shows UPC and stock count", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /admin && module\.id === "spirits" \? <span className="stock-chip">\{spiritStockLabel\(item\.stock_count\)\}/
  );
  assert.match(slice, /admin && item\.upc \? <span>UPC \{String\(item\.upc\)\}<\/span>/);
});

test("D. Guest wine card hides UPC", () => {
  const slice = inventoryCardSlice();
  assert.match(slice, /admin && item\.upc \? <span>UPC/);
});

test("E. Guest wine card hides bottle_count", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /admin && item\.bottle_count != null && module\.id !== "packaged_beer" \? <span className="stock-chip">\{item\.bottle_count\} bottles<\/span>/
  );
});

test("F. Keeper wine card still shows bottle_count and UPC", () => {
  const slice = inventoryCardSlice();
  assert.match(slice, /admin && item\.bottle_count != null && module\.id !== "packaged_beer"/);
  assert.match(slice, /admin && item\.upc/);
});

test("G. Guest packaged beer card hides UPC", () => {
  const slice = inventoryCardSlice();
  assert.match(slice, /admin && item\.upc \? <span>UPC/);
});

test("H. Guest packaged beer card hides quantity/count", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /admin && module\.id === "packaged_beer" \? <span className="stock-chip">\{packagedStockLabel\(item\.count, item\.vessel\)\}/
  );
});

test("I. Keeper packaged beer card still shows count and UPC", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /admin && module\.id === "packaged_beer" \? <span className="stock-chip">\{packagedStockLabel/
  );
  assert.match(slice, /admin && item\.upc/);
});

test("J. Guest bottle detail hides UPC", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /admin && item\.upc \? <span>UPC \{String\(item\.upc\)\}<\/span>/);
  assert.match(detail, /if\s*\(!admin\)\s*\{[\s\S]*?skip\.add\("upc"\)/);
});

test("K. Guest bottle detail hides raw inventory count fields", () => {
  const detail = bottleDetailSlice();
  assert.match(
    detail,
    /admin && module\.id === "spirits" \? <span>\{spiritStockLabel\(item\.stock_count\)\}<\/span>/
  );
  assert.match(detail, /admin && item\.bottle_count != null && module\.id !== "packaged_beer"/);
  assert.match(detail, /admin && packagedLabel \? <span>\{packagedLabel\}<\/span>/);
  assert.match(detail, /admin && module\.id === "packaged_beer" && <div className="full">/);
  assert.match(detail, /if\s*\(!admin\)\s*\{[\s\S]*?skip\.add\("bottle_count"\)/);
});

test("L. Keeper bottle detail preserves UPC/count fields", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /admin && item\.upc \? <span>UPC \{String\(item\.upc\)\}<\/span>/);
  assert.match(
    detail,
    /admin && module\.id === "spirits" \? <span>\{spiritStockLabel\(item\.stock_count\)\}<\/span>/
  );
  assert.match(detail, /admin && item\.bottle_count != null/);
  assert.match(detail, /admin && packagedLabel/);
  assert.match(detail, /admin && module\.id === "spirits" && <div className="full">/);
  assert.match(detail, /spiritStockLabel\(item\.stock_count\)/);
  assert.match(
    detail,
    /admin && module\.id === "packaged_beer" && <div className="full">[\s\S]*In the cold room/
  );
});

test("M. Guest still sees normal product metadata wiring", () => {
  const detail = bottleDetailSlice();
  assert.match(detail, /item\.abv &&/);
  assert.match(detail, /% ABV/);
  assert.match(detail, /item\.volume_ml \? <span>\{item\.volume_ml\} ml<\/span>/);
  assert.match(detail, /displayCanonicalFamily/);
  assert.match(detail, /displayCanonicalType/);
  assert.match(detail, /item\.style/);
  assert.match(detail, /item\[module\.makerKey\]/);
});

test("N. Out-of-stock / blocked behavior remains unchanged", () => {
  assert.match(
    appSrc,
    /const outOfStock = \(module\.id === "packaged_beer" && packagedCount\(item\.count\) <= 0\)\s*\|\|\s*\(module\.id === "spirits" && isSpiritEmpty\(item\)\);/
  );
  assert.match(appSrc, /const blocked = Number\(item\.blocked_from_ordering \?\? 0\) === 1;/);
  assert.match(appSrc, /outOfStock \? " out-of-stock" : ""/);
  assert.match(appSrc, /blocked \? " blocked-bottle" : ""/);
  assert.match(appSrc, /blocked && <span className="blocked-ribbon">\{BLOCKED_RIBBON_LABEL\}<\/span>/);
  const slice = inventoryCardSlice();
  assert.match(slice, /out-of-stock/);
  assert.match(slice, /blocked-bottle/);
});
