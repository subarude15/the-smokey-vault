import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "./db.js";
import { parseFwgsBarcodeHtml } from "./fwgs.js";
import { isPlausibleBarUpcItem, lookupUpcItemDb } from "./ingestion/catalogs/upcitemdb.js";
import { lookupProduct } from "./lookup.js";

const BUFFALO_TRACE_UPC = "080244009250";
const ARDBEG_UPC = "083300072045";

function clearCaches(upc: string) {
  db.prepare("DELETE FROM cola_cache WHERE upc = ?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc = ?").run(upc);
  db.prepare("DELETE FROM beer_cache WHERE upc = ?").run(upc);
}

test("parseFwgsBarcodeHtml rejects unrelated featured products (e.g. Everclear) even when search input echoes the UPC", () => {
  const html = `
    <!doctype html>
    <html>
    <head>
      <meta property="og:title" content="Everclear Grain Alcohol 190 Proof | Fine Wine &amp; Good Spirits">
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "itemListElement": [{
          "@type": "Product",
          "name": "Everclear Grain Alcohol 190 Proof",
          "brand": { "@type": "Brand", "name": "Everclear" },
          "gtin12": "088352100036",
          "size": "750 ML",
          "offers": { "@type": "Offer", "price": "21.99" }
        }]
      }
      </script>
    </head>
    <body>
      <form action="/search"><input name="Ntt" value="${BUFFALO_TRACE_UPC}"></form>
      <div class="product-tile" data-pid="ec-1">
        <a class="product-name" href="/product/everclear">Everclear Grain Alcohol 190 Proof</a>
        <span class="product-size">750 ML</span>
        <span class="product-price">$21.99</span>
      </div>
    </body>
    </html>
  `;
  assert.equal(parseFwgsBarcodeHtml(html, BUFFALO_TRACE_UPC), null);
});

test("parseFwgsBarcodeHtml rejects a product page without any UPC corroboration in JSON-LD or product card", () => {
  const html = `
    <html><body>
      <div class="product-tile">
        <a class="product-name" href="/product/everclear">Everclear Grain Alcohol</a>
        <span class="product-size">750 ML</span>
      </div>
    </body></html>
  `;
  assert.equal(parseFwgsBarcodeHtml(html, BUFFALO_TRACE_UPC), null);
});

test("parseFwgsBarcodeHtml accepts JSON-LD or card hits that explicitly corroborate the searched UPC", () => {
  const jsonLdHit = parseFwgsBarcodeHtml(`
    <html><head>
      <script type="application/ld+json">
      {
        "@type": "Product",
        "name": "Buffalo Trace Kentucky Straight Bourbon Whiskey",
        "brand": { "@type": "Brand", "name": "Buffalo Trace" },
        "gtin13": "0${BUFFALO_TRACE_UPC}",
        "size": "375 ML",
        "offers": { "@type": "Offer", "price": "17.99" }
      }
      </script>
    </head><body></body></html>
  `, BUFFALO_TRACE_UPC);
  assert.ok(jsonLdHit);
  assert.equal(jsonLdHit.name, "Buffalo Trace Kentucky Straight Bourbon Whiskey");
  assert.equal(jsonLdHit.volume_ml, 375);

  const cardHit = parseFwgsBarcodeHtml(`
    <html><body>
      <div class="product-tile" data-upc="${BUFFALO_TRACE_UPC}">
        <a class="product-name" href="/product/bt">Buffalo Trace Bourbon</a>
        <span class="product-size">375 ML</span>
      </div>
    </body></html>
  `, BUFFALO_TRACE_UPC);
  assert.ok(cardHit);
  assert.equal(cardHit.name, "Buffalo Trace Bourbon");
});

test("isPlausibleBarUpcItem rejects hardware bolts and non-beverage merchandise while accepting bar products", () => {
  assert.equal(
    isPlausibleBarUpcItem({
      title: "5/16-18 x 2 in. Zinc-Plated Hex Bolt",
      brand: "Everbilt",
      category: "Hardware > Building Consumables > Hardware > Fasteners > Bolts"
    }),
    false
  );
  assert.equal(
    isPlausibleBarUpcItem({
      title: "Stainless Carriage Bolt 1/4-20",
      brand: "Hillman",
      category: ""
    }),
    false
  );
  assert.equal(
    isPlausibleBarUpcItem({
      title: "USB-C Charging Cable 6ft",
      brand: "Anker",
      category: "Electronics > Cables"
    }),
    false
  );

  assert.equal(
    isPlausibleBarUpcItem({
      title: "Ardbeg Uigeadail Islay Single Malt Scotch Whisky 750ml",
      brand: "Ardbeg",
      category: "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages > Liquor & Spirits"
    }),
    true
  );
  assert.equal(
    isPlausibleBarUpcItem({
      title: "Buffalo Trace Kentucky Straight Bourbon Whiskey 375ml",
      brand: "Buffalo Trace",
      category: ""
    }),
    true
  );
  assert.equal(
    isPlausibleBarUpcItem({
      title: "Fever-Tree Indian Tonic Water",
      brand: "Fever-Tree",
      category: "Food, Beverages & Tobacco > Beverages"
    }),
    true
  );
});

test("lookupUpcItemDb rejects hardware bolts and mismatched UPCs without caching them", async () => {
  clearCaches(ARDBEG_UPC);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      items: [{
        upc: ARDBEG_UPC,
        title: "3/8-16 x 1-1/2 in. Hex Bolt",
        brand: "Crown Bolt",
        category: "Hardware > Fasteners > Bolts",
        images: ["https://example.com/bolt.jpg"]
      }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const direct = await lookupUpcItemDb(ARDBEG_UPC);
    assert.equal(direct, null);

    const lookup = await lookupProduct(ARDBEG_UPC, {
      kind: "spirits",
      catalogs: {
        searchFwgs: async () => null,
        searchCola: async () => null,
        searchOff: async () => null,
        searchUpcItemDb: lookupUpcItemDb
      }
    });
    assert.equal(lookup.source, "not_found");
    const cached = db.prepare("SELECT name, source FROM cola_cache WHERE upc = ?").get(ARDBEG_UPC) as
      | { name: string; source: string }
      | undefined;
    assert.equal(cached?.name ?? "", "", "rejected upcitemdb hardware hit must not be cached as a product");
    assert.notEqual(cached?.source, "upcitemdb");

    // Mismatched UPC returned by UPCitemdb is also rejected even if it looks like whiskey.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      items: [{
        upc: "000000000001",
        title: "Some Other Bourbon Whiskey 750ml",
        brand: "Other",
        category: "Food, Beverages & Tobacco > Beverages > Alcoholic Beverages"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    assert.equal(await lookupUpcItemDb(ARDBEG_UPC), null);
  } finally {
    globalThis.fetch = originalFetch;
    clearCaches(ARDBEG_UPC);
  }
});
