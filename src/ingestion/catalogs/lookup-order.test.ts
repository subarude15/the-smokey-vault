import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { lookupProduct, type LookupCatalogs } from "../../lookup.js";

/**
 * Explicit call-order guards for the catalog stages.
 * Spirits: FWGS → COLA → OFF → upcitemdb
 * Beer: OFF → upcitemdb → COLA (FWGS never)
 */
test("spirits catalogs are called FWGS then COLA then OFF then upcitemdb", async () => {
  const upc = "055566677788";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  const order: string[] = [];
  const catalogs: LookupCatalogs = {
    searchFwgs: async () => {
      order.push("fwgs");
      return null;
    },
    searchCola: async () => {
      order.push("cola");
      return null;
    },
    searchOff: async () => {
      order.push("off");
      return null;
    },
    searchUpcItemDb: async () => {
      order.push("upcitemdb");
      return null;
    }
  };
  const result = await lookupProduct(upc, { kind: "spirits", catalogs });
  assert.deepEqual(order, ["fwgs", "cola", "off", "upcitemdb"]);
  assert.equal(result.reason, "cola_gap");
});

test("beer catalogs skip FWGS and call OFF then upcitemdb then COLA", async () => {
  const upc = "055566677799";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM beer_cache WHERE upc=?").run(upc);
  const order: string[] = [];
  const catalogs: LookupCatalogs = {
    searchFwgs: async () => {
      order.push("fwgs");
      return null;
    },
    searchCola: async () => {
      order.push("cola");
      return null;
    },
    searchOff: async () => {
      order.push("off");
      return null;
    },
    searchUpcItemDb: async () => {
      order.push("upcitemdb");
      return null;
    }
  };
  const result = await lookupProduct(upc, { kind: "beer", catalogs });
  assert.deepEqual(order, ["off", "upcitemdb", "cola"]);
  assert.ok(!order.includes("fwgs"));
  assert.equal(result.source, "not_found");
});

test("liquor stops at FWGS and never reaches later catalogs", async () => {
  const upc = "055566677700";
  db.prepare("DELETE FROM cola_cache WHERE upc=?").run(upc);
  db.prepare("DELETE FROM barcode_cache WHERE upc=?").run(upc);
  const order: string[] = [];
  const catalogs: LookupCatalogs = {
    searchFwgs: async () => {
      order.push("fwgs");
      return {
        name: "Stop Here Bourbon",
        brand: "Stop",
        volume_ml: 750,
        price: "$20",
        image_url: null
      };
    },
    searchCola: async () => {
      order.push("cola");
      return null;
    },
    searchOff: async () => {
      order.push("off");
      return null;
    },
    searchUpcItemDb: async () => {
      order.push("upcitemdb");
      return null;
    }
  };
  const result = await lookupProduct(upc, { catalogs });
  assert.equal(result.source, "fwgs");
  assert.deepEqual(order, ["fwgs"]);
});
