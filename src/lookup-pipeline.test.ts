import assert from "node:assert/strict";
import { test } from "node:test";
import { ColaQuotaError, resetColaBurst, searchByBarcode } from "./cola_client.js";
import { lookupProduct, type LookupCatalogs } from "./lookup.js";
import { missMessage } from "./lookup-shared.js";
import { db } from "./db.js";

const silent: LookupCatalogs = {
  searchFwgs: async () => null,
  searchCola: async () => null,
  searchOff: async () => null,
  searchUpcItemDb: async () => null
};

test("invalid barcodes miss with reason invalid and never say not found in quota copy", () => {
  const copy = missMessage("quota");
  assert.match(copy, /paused/i);
  assert.doesNotMatch(copy, /not found/i);
});

test("garbage input is an invalid barcode miss", async () => {
  const result = await lookupProduct("not a code", { kind: "spirits", catalogs: silent });
  assert.equal(result.reason, "invalid");
  assert.equal(result.source, "not_found");
  assert.equal(result.kind, "spirits");
  assert.match(result.message ?? "", /Not a barcode/);
});

test("mixers skip catalogs and miss to no_catalog", async () => {
  const upc = "077788899900";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  let fwgs = 0;
  let cola = 0;
  let off = 0;
  const result = await lookupProduct(upc, {
    kind: "mixers",
    catalogs: {
      searchFwgs: async () => { fwgs += 1; return { name: "Nope", brand: "", volume_ml: 750, price: "", image_url: null }; },
      searchCola: async () => { cola += 1; return { product_name: "Nope" }; },
      searchOff: async () => { off += 1; return null; },
      searchUpcItemDb: async () => null
    }
  });
  assert.equal(result.reason, "no_catalog");
  assert.equal(result.kind, "mixers");
  assert.equal(fwgs, 0);
  assert.equal(cola, 0);
  assert.equal(off, 0);
});

test("beer never calls FWGS or COLA and uses Open Food Facts", async () => {
  const upc = "001200000000";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  let fwgs = 0;
  let cola = 0;
  const result = await lookupProduct(upc, {
    kind: "beer",
    catalogs: {
      searchFwgs: async () => { fwgs += 1; return { name: "Liquor", brand: "", volume_ml: 750, price: "", image_url: null }; },
      searchCola: async () => { cola += 1; return { product_name: "Liquor" }; },
      searchOff: async () => ({
        upc: "001200000000",
        name: "Nugget Nectar",
        brand: "Troegs",
        category: "Beer",
        abv: 7.5,
        image_url: null,
        fill_level_percent: 100,
        bottle_count: 1,
        notes: null,
        volume_ml: 355,
        product_type: "MALT BEVERAGE",
        ttb_id: null,
        origin: null,
        approval_date: null
      }),
      searchUpcItemDb: async () => null
    }
  });
  assert.equal(result.source, "openfoodfacts");
  assert.equal(result.table, "packaged_beer");
  assert.equal(result.product?.name, "Nugget Nectar");
  assert.equal(fwgs, 0);
  assert.equal(cola, 0);
});

test("liquor uses FWGS before COLA and skips COLA when the store hit is complete", async () => {
  const upc = "080686000891";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  let cola = 0;
  const result = await lookupProduct(upc, {
    catalogs: {
      searchFwgs: async () => ({
        name: "Buffalo Trace Kentucky Straight Bourbon Whiskey",
        brand: "Buffalo Trace",
        volume_ml: 750,
        price: "$27.99",
        image_url: null
      }),
      searchCola: async () => { cola += 1; return { product_name: "Should not run" }; },
      searchOff: async () => null,
      searchUpcItemDb: async () => null
    }
  });
  assert.equal(result.source, "fwgs");
  assert.equal(result.product?.name, "Buffalo Trace Kentucky Straight Bourbon Whiskey");
  assert.equal(cola, 0);
});

test("thin FWGS still asks COLA once for a TTB record", async () => {
  const upc = "080244009365";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  let cola = 0;
  const result = await lookupProduct(upc, {
    catalogs: {
      searchFwgs: async () => ({
        name: "Eagle Rare 10 Year",
        brand: "Eagle Rare",
        volume_ml: null,
        price: "$42.99",
        image_url: null
      }),
      searchCola: async () => {
        cola += 1;
        return { ttb_id: "TTB-ER", brand_name: "Eagle Rare", product_name: "Eagle Rare 10 Year", product_type: "DISTILLED SPIRITS" };
      },
      searchOff: async () => null,
      searchUpcItemDb: async () => null
    }
  });
  assert.equal(result.source, "fwgs");
  assert.equal(result.product?.ttb_id, "TTB-ER");
  assert.equal(result.product?.image_url, "", "empty photo is not a miss");
  assert.equal(cola, 1);
});

test("a COLA quota error pauses COLA only and surfaces reason quota, not not found", async () => {
  const upc = "066677788899";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  const result = await lookupProduct(upc, {
    catalogs: {
      searchFwgs: async () => null,
      searchCola: async () => { throw new ColaQuotaError(); },
      searchOff: async () => null,
      searchUpcItemDb: async () => null
    }
  });
  assert.equal(result.reason, "quota");
  assert.doesNotMatch(result.message ?? "", /not found/i);
  assert.match(result.message ?? "", /paused/i);
});

test("UPC-E scans are treated as a code-format miss when catalogs are empty", async () => {
  const result = await lookupProduct("04252614", { catalogs: silent });
  assert.equal(result.reason, "variant");
  assert.ok(result.variants?.upcA);
  assert.ok(result.variants?.ean13);
  assert.match(result.message ?? "", /UPC-A/);
});

test("liquor with a COLA list miss and no catalog hit is cola_gap", async () => {
  const upc = "012398745601";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  const result = await lookupProduct(upc, {
    catalogs: {
      searchFwgs: async () => null,
      searchCola: async () => null,
      searchOff: async () => null,
      searchUpcItemDb: async () => null
    }
  });
  assert.equal(result.reason, "cola_gap");
  assert.equal(result.source, "not_found");
});

test("searchByBarcode makes one HTTP call to the barcode endpoint", async () => {
  const previous = process.env.COLA_API_KEY;
  process.env.COLA_API_KEY = "unit-test-key";
  resetColaBurst();
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const hit = await searchByBarcode("008066095702");
    assert.equal(hit, null);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /\/barcode\/008066095702/);
    assert.doesNotMatch(urls[0]!, /barcode_value=/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous == null) delete process.env.COLA_API_KEY;
    else process.env.COLA_API_KEY = previous;
    resetColaBurst();
  }
});
