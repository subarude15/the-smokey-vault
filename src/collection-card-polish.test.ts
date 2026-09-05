/**
 * PR #89 — collection-card visual polish guards.
 * UI structure only: no enrichment / image-selection / API semantic changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(root, "client/src/styles.css"), "utf8");

function inventoryCardSlice(): string {
  const marker = "inventory-card inventory-card-button";
  const idx = appSrc.indexOf(marker);
  assert.ok(idx >= 0, "shared inventory collection card present");
  const start = appSrc.lastIndexOf("<button", idx);
  const end = appSrc.indexOf("</button>", start);
  assert.ok(start >= 0 && end > start, "inventory card button bounds");
  return appSrc.slice(start, end + "</button>".length);
}

test("A. collection cards still prefer display_image_url ?? image_url", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /display_image_url\s*\?\?\s*item\.image_url/,
    "card image precedence must remain display_image_url ?? image_url"
  );
});

test("B. no-image cards still render module placeholder icon", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /cardImage\s*\?\s*<img[^>]*\/?\>\s*:\s*<module\.icon\s*\/>/,
    "empty cardImage must fall back to module.icon placeholder"
  );
  assert.doesNotMatch(
    slice,
    /onError|retry|fetch\(.*image/i,
    "polish must not add broken-image network retries or new image logic"
  );
});

test("C. Spirits / Wines / Packaged Beer share one inventory-card structure", () => {
  const marker = "inventory-card inventory-card-button";
  const occurrences = appSrc.split(marker).length - 1;
  assert.equal(occurrences, 1, "exactly one shared inventory-card button template");

  const slice = inventoryCardSlice();
  assert.match(slice, /className="card-icon"/);
  assert.match(slice, /className="card-content"/);
  assert.match(slice, /className="eyebrow"/);
  assert.match(slice, /className="meta"/);
  assert.match(slice, /module\.id === "spirits"/);
  assert.match(slice, /module\.id === "wines"/);
  assert.match(slice, /module\.id === "packaged_beer"/);
});

test("D. click-to-open-detail behavior unchanged", () => {
  const slice = inventoryCardSlice();
  assert.match(
    slice,
    /onClick=\{\(\)\s*=>\s*openBottleDetail\(item(?:,\s*module\.id)?\)\}/,
    "collection cards must still open detail via openBottleDetail(item)"
  );
  assert.match(slice, /type="button"/);
});

test("E. mobile card markup keeps overflow-safe flex constraints", () => {
  assert.match(
    cssSrc,
    /\.card-content\{[^}]*min-width:\s*0/,
    "card-content must keep min-width:0 to avoid horizontal overflow"
  );
  assert.match(
    cssSrc,
    /\.meta\{[^}]*flex-wrap:\s*wrap/,
    "meta chips must wrap"
  );
  assert.match(
    cssSrc,
    /\.inventory-card \.card-content h3\{[^}]*overflow-wrap:\s*anywhere/,
    "long product titles must wrap inside the card"
  );
});

test("inventory-card image area uses contain with intentional footprint", () => {
  assert.match(
    cssSrc,
    /\.inventory-card \.card-icon\{[^}]*width:\s*76px/,
    "inventory card image area modestly larger than shared icon default"
  );
  assert.match(
    cssSrc,
    /\.inventory-card \.card-icon img\{[^}]*object-fit:\s*contain/,
    "product images use contain so bottles keep aspect"
  );
  assert.match(
    cssSrc,
    /(?<![\w-])\.card-icon\{width:62px;height:82px/,
    "non-inventory card-icon size preserved"
  );
});

test("stock chips stay visible and secondary metadata stays quieter", () => {
  const slice = inventoryCardSlice();
  assert.match(slice, /className="stock-chip"/);
  assert.match(slice, /spiritStockLabel/);
  assert.match(slice, /packagedStockLabel/);
  assert.match(slice, /admin && item\.upc \? <span>UPC/);
  assert.match(
    cssSrc,
    /\.inventory-card \.meta span\.stock-chip\{/,
    "stock-chip polish styles present"
  );
  assert.match(
    cssSrc,
    /\.inventory-card \.eyebrow\{[^}]*font-size:\s*9px/,
    "brand eyebrow quieter on inventory cards"
  );
  assert.match(
    cssSrc,
    /\.inventory-card \.card-content h3\{[^}]*font:\s*600\s*19px/,
    "product title remains dominant but not oversized"
  );
});

test("polish does not touch enrichment or image persistence paths", () => {
  const slice = inventoryCardSlice();
  // Ignore existing comments that mention enrichment as documentation only.
  const codeOnly = slice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    codeOnly,
    /localizeImage|saveImageBuffer|product_images|Figranium|upsertProductImage/,
    "collection card markup must not introduce enrichment/persistence calls"
  );
});
